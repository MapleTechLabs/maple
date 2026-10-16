/**
 * The solver: one production chat turn.
 *
 * Runs `runChatTurn` exactly as the Durable Object does: the session's agent and system prompt,
 * the `chat` surface's tools and permission ruleset, and the registry's own decoding. Only the
 * warehouse is fake. The transcript keeps every call the model made, how the registry read it,
 * and what it was shown back, so a grade can always be checked against the trial.
 */
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import type { ChatTurnEvent } from "../chat/events"
import { runChatTurn } from "../chat/run"
import { makeRunUsage, type RunUsage, type SubmitDiagnosis } from "../chat/tools"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { evalModel } from "./model"
import { observeCall, type ObservedCall } from "./targets"

export interface TranscriptCall extends ObservedCall {
	/** What the model was shown, truncated for the artifact. */
	readonly output: string
	/** The engine announced it as an approval-gated proposal; it did not run. */
	readonly proposed: boolean
}

export interface Transcript {
	readonly calls: ReadonlyArray<TranscriptCall>
	readonly answer: string
	readonly usage: RunUsage
	readonly durationMs: number
	/** The engine's terminal reason, `call-cap` when the eval stopped the turn, or `failed: …`. */
	readonly endReason: string
	/** The run failed before it could finish: an infrastructure failure, not a wrong answer. */
	readonly errored: boolean
}

export interface ChatTurnInput {
	readonly executor: McpToolExecutorApi
	readonly tenant: TenantContext
	readonly text: string
	/** Session tab prefix; picks the agent (`eval-` is the default chat agent, `inv-` investigation). */
	readonly tab?: string
	readonly origin?: ChatTurnOrigin
	/** Stop the turn once this many tool results have come back. */
	readonly maxToolCalls: number
	readonly submitDiagnosis?: SubmitDiagnosis
}

const OUTPUT_CHARS = 4_000

const render = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value))

export const solveChatTurn = (input: ChatTurnInput): Effect.Effect<Transcript> => {
	const { model, clients } = evalModel()
	const pending = new Map<
		string,
		{ readonly name: string; readonly input: unknown; readonly proposed: boolean }
	>()
	const done: Array<TranscriptCall> = []
	let answer = ""
	let endReason = "unknown"
	let errored = false
	const usage = makeRunUsage()
	const started = Date.now()

	const append = (event: ChatTurnEvent) => {
		// A sub-agent's events belong to its task card, not to this turn's answer.
		if (event.task !== undefined) return
		switch (event.type) {
			case "text-delta":
				answer += event.text
				return
			case "turn-retry":
				answer = answer.slice(0, Math.max(0, answer.length - event.retractChars))
				return
			case "tool-call":
				pending.set(event.callId, {
					name: event.name,
					input: event.input,
					proposed: event.proposed === true,
				})
				return
			case "tool-result": {
				const made = pending.get(event.callId)
				if (made === undefined) return
				pending.delete(event.callId)
				done.push({
					...observeCall(made.name, made.input, event.isError === true),
					output: render(event.output).slice(0, OUTPUT_CHARS),
					proposed: made.proposed,
				})
				return
			}
			case "turn-end":
				// The first terminal reason is the one that explains the turn; never overwrite it.
				if (endReason === "unknown") {
					endReason = event.error === undefined ? event.reason : `${event.reason}: ${event.error}`
				}
				return
			default:
				return
		}
	}

	const tab = input.tab ?? "eval-"
	return runChatTurn({
		sessionId: `${input.tenant.orgId}:${tab}${randomUUID()}`,
		messageId: randomUUID(),
		tenant: input.tenant,
		origin: input.origin ?? { kind: "app" },
		toolExecutor: input.executor,
		model,
		submitDiagnosis: input.submitDiagnosis ?? (() => Effect.void),
		text: input.text,
		history: [],
		usage,
		holdsTurn: () => done.length < input.maxToolCalls,
		append,
	}).pipe(
		// A trial is an entry point: the clients are built for it and gone with it.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(clients),
		Effect.catchCause((cause) =>
			Effect.sync(() => {
				errored = true
				endReason = `failed: ${String(cause).slice(0, 2_000)}`
			}),
		),
		Effect.map(() => {
			// Calls announced but never answered: an approval-gated proposal, or the cap cut them off.
			const unanswered = [...pending.values()].map((made) => ({
				...observeCall(made.name, made.input, false),
				output: "",
				proposed: made.proposed,
			}))
			return {
				calls: [...done, ...unanswered],
				answer,
				usage,
				durationMs: Date.now() - started,
				endReason:
					endReason === "unknown" && done.length >= input.maxToolCalls ? "call-cap" : endReason,
				errored,
			}
		}),
	)
}
