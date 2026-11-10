/**
 * What a run spent, as it spends it: token totals and AI credit charges, filled by a budget hook
 * the engine calls on every model call.
 */
import type { AiModelSpend } from "@maple/backend/services/billing/autumn-tracker"
import type { RunBudgetHook, RunUsageDelta } from "@yielded/agent/run-options"
import type { ModelCallUsage } from "@yielded/agent/usage"
import { Effect } from "effect"
import { autumnModelId } from "../platform/ai-credits"

/**
 * Token totals for the run so far.
 *
 * Mutable and shared rather than returned, because `submit_diagnosis` is a *tool* invoked mid-run,
 * so there is no "after the run" moment at which to hand it a total. The Durable Object accumulates
 * it from the run's events; the billing charge is raised separately once the run ends.
 */
export interface RunUsage {
	input: number
	output: number
	cacheRead: number
	/** The same calls as AI credit charges, in Autumn's exclusive pools; see {@link recordCharge}. */
	readonly charges: Array<Mutable<AiModelSpend>>
	/**
	 * The part of the totals above that the run's child agents (`review_files`) spent, as the engine
	 * reports each one ending. Their calls are charged with the run's own.
	 */
	readonly delegated: { modelCalls: number; input: number; output: number; costMicrousd: number }
}

type Mutable<A> = { -readonly [K in keyof A]: A[K] }

export const makeRunUsage = (): RunUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	charges: [],
	delegated: { modelCalls: 0, input: 0, output: 0, costMicrousd: 0 },
})

/**
 * Below every long-context tier models.dev lists (the smallest is 32k). Autumn picks a model's
 * tier from one charge's total input, so a charge that sums calls past a tier bills them all at
 * the long-context rate. Calls are merged only while their sum stays under it.
 */
const MERGE_CEILING_TOKENS = 32_000

const chargeInput = (spend: AiModelSpend) =>
	spend.inputTokens + spend.cacheReadTokens + spend.cacheWriteTokens

/** One model call into the run's AI credit charges, merged into the last one when that is safe. */
const recordCharge = (usage: RunUsage, call: ModelCallUsage) => {
	const charge = {
		modelId: autumnModelId(call.model),
		inputTokens: call.inputTokens.uncached,
		outputTokens: call.outputTokens.text,
		cacheReadTokens: call.inputTokens.cacheRead,
		cacheWriteTokens: call.inputTokens.cacheWrite,
		reasoningTokens: call.outputTokens.reasoning,
	}
	const last = usage.charges.at(-1)
	if (
		last === undefined ||
		last.modelId !== charge.modelId ||
		chargeInput(last) + chargeInput(charge) > MERGE_CEILING_TOKENS
	) {
		usage.charges.push(charge)
		return
	}
	last.inputTokens += charge.inputTokens
	last.outputTokens += charge.outputTokens
	last.cacheReadTokens += charge.cacheReadTokens
	last.cacheWriteTokens += charge.cacheWriteTokens
	last.reasoningTokens += charge.reasoningTokens
}

/**
 * A budget hook that only watches.
 *
 * `guard` passes every pull through untouched and `consume` never rejects, because the ceilings a
 * run answers to are its `AgentPolicy`. What this exists for is the side effect: the run event
 * stream reports no token usage at all, so without it every reader of {@link RunUsage} — the
 * metering finalizer, `submit_diagnosis`, and every workflow pass's reported cost — sees zeros.
 */
export const accumulateUsage = (usage: RunUsage): RunBudgetHook => ({
	guard: (effect) => effect,
	consume: (delta: RunUsageDelta) =>
		Effect.sync(() => {
			usage.input += delta.inputTokens
			usage.output += delta.outputTokens
			usage.cacheRead += delta.usage.inputTokens.cacheRead ?? 0
			// Absent only on tool-only charges, which carry no tokens.
			if (delta.modelUsage !== undefined) recordCharge(usage, delta.modelUsage)
		}),
})
