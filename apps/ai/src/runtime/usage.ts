import type { RunBudgetHook, RunUsageDelta } from "@effect-agent/engine/RunOptions"
import { Effect } from "effect"

/**
 * Token totals for the run so far.
 *
 * Mutable and shared rather than returned, because `submit_diagnosis` is a *tool* invoked mid-run,
 * so there is no "after the run" moment at which to hand it a total. The engine's usage hook updates
 * it during execution; the billing charge is raised separately once the run ends.
 */
import type { RunUsage } from "@maple/domain/ai-service"
export { makeRunUsage, type RunUsage } from "@maple/domain/ai-service"

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
		}),
})
