/**
 * Running one agent turn into a chat session.
 *
 * The seam between the engine and the Durable Object: this module builds the run, the Durable
 * Object owns ordering and the turn slot, and `turn-runner.ts` owns tenancy, metering and the turn
 * span. Nothing here decides *when* a tool is called — that is the engine's job now.
 */
import { evaluatePermission } from "@maple/domain/permission"
import type { ChatMessage } from "@maple/domain/chat-session"
import * as AgentRuntime from "@effect-agent/engine/AgentRuntime"
import { ThreadHistory } from "@effect-agent/engine/ThreadHistory"
import { IdGenerator } from "@effect-agent/core/IdGenerator"
import { ThreadId } from "@effect-agent/core/Identifiers"
import { Effect, Layer, Schema, Stream } from "effect"
import { Prompt, Toolkit } from "effect/unstable/ai"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { agentSessionSpanAttributes, type ResolvedModel } from "../platform/Llm"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { agentForSession, chatAgent } from "./agents"
import { rulesetForTurn } from "./permissions"
import { toChatEvents, type ChatTurnEvent } from "./events"
import {
	accumulateUsage,
	buildChatToolkit,
	buildDiagnosisCompletion,
	isAutonomousInvestigationTurn,
	SUBMIT_DIAGNOSIS,
	type RunUsage,
	type SubmitDiagnosis,
} from "./tools"

/**
 * The transcript the model starts from.
 *
 * Supplied as run options rather than retained by the engine: `ChatSession` is the authority on what
 * was said, and a second history owner would be a second answer to the same question.
 *
 * Bounded by count and characters, and that is the whole of it. There was a durable `compaction`
 * event here once, carrying a summary and a `throughSeq` to replay from, but nothing ever wrote one:
 * the engine's compaction is per-model-call and lives inside the run, and `toChatEvents` mapped
 * `CompactionPerformed` to nothing. Summarizing *across* turns is a separate design, not a branch
 * that was already half-built.
 */
export const promptFromHistory = (history: ReadonlyArray<ChatMessage>): ReadonlyArray<PromptMessage> => {
	const spoken = history.filter((message) => message.text.trim() !== "")

	// Bounded here as well as by the policy's context limit. Compaction acts once a request crosses
	// the limit; this keeps the *first* request of a long conversation from being the one that does.
	// Walk backwards so the newest turns are the ones kept — the tail is what the next turn needs.
	const kept: Array<ChatMessage> = []
	let chars = 0
	for (let i = spoken.length - 1; i >= 0; i--) {
		const message = spoken[i]!
		if (kept.length >= MAX_REPLAYED_MESSAGES) break
		if (chars + message.text.length > MAX_REPLAYED_CHARS && kept.length > 0) break
		chars += message.text.length
		kept.push(message)
	}
	kept.reverse()

	return kept.map((message) => ({
		role: message.role === "user" ? ("user" as const) : ("assistant" as const),
		content: [{ type: "text" as const, text: message.text }],
	}))
}

/** One replayed turn, in the shape `Prompt.make` accepts. */
export interface PromptMessage {
	readonly role: "user" | "assistant"
	readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
}

const MAX_REPLAYED_MESSAGES = 40
const MAX_REPLAYED_CHARS = 60_000

export interface ChatRunInput {
	readonly sessionId: string
	readonly messageId: string
	readonly tenant: TenantContext
	readonly toolExecutor: McpToolExecutorApi
	readonly model: ResolvedModel
	readonly submitDiagnosis: SubmitDiagnosis
	/** This run is an autonomous pass's close-out: a report it files is a partial. */
	readonly closeOut?: boolean
	/** The message the user just sent, which is this run's input. */
	readonly text: string
	readonly history: ReadonlyArray<ChatMessage>
	/** Accumulated across the run; `submit_diagnosis` reads it mid-run. */
	readonly usage: RunUsage
	/** False once the turn slot has been released, which stops the run writing into a moved-on session. */
	readonly holdsTurn: () => boolean
	readonly append: (event: ChatTurnEvent) => void
}

export interface ChatRunOutcome {
	/** This run was an investigation's own autonomous pass. */
	readonly autonomous: boolean
	/** `submit_diagnosis` landed a report during this run. */
	readonly submittedDiagnosis: boolean
	/**
	 * How many times the engine compacted this run's context.
	 *
	 * Reported because the limit that triggers it is set from measured prod traffic, and a limit set
	 * from traffic has to be watched against it. Compaction should be rare; routinely non-zero means
	 * either the bound is too tight or a run is carrying far more evidence than it is reading.
	 */
	readonly compactions: number
}

/**
 * Build and drain one run.
 *
 * The returned Effect settles when the run does. Every chat event it produces has already been
 * appended by the time it settles, and the terminal reason is whatever the engine reported — this
 * module never invents one.
 */
export const runChatTurn = (input: ChatRunInput) => {
	const definition = agentForSession(input.sessionId)
	// Not `definition.permission`: an unattended pass is offered fewer tools than the same agent
	// answering a person in the same session. See `rulesetForTurn`.
	const ruleset = rulesetForTurn(definition, isAutonomousInvestigationTurn(input.sessionId, input.tenant))
	const maple = buildChatToolkit(
		input.toolExecutor,
		input.tenant,
		ruleset,
		"chat",
		agentSessionSpanAttributes(input.model.tags),
	)
	const completion = buildDiagnosisCompletion(
		input.sessionId,
		input.tenant,
		input.submitDiagnosis,
		input.usage,
		input.model.name,
		input.closeOut === true,
		agentSessionSpanAttributes(input.model.tags),
	)

	const toolkit = Toolkit.merge(maple.toolkit, ...(completion === undefined ? [] : [completion.toolkit]))
	const handlers = Layer.mergeAll(maple.layer, ...(completion === undefined ? [] : [completion.layer]))

	// Declared but never *required*: see `buildDiagnosisCompletion`. A call still settles the run.
	const agent = chatAgent(definition, toolkit, input.model, {
		...(completion === undefined
			? undefined
			: { completion: { tool: SUBMIT_DIAGNOSIS, required: false } }),
	})

	// A gated tool is announced exactly like any other and refuses when dispatched, so only the
	// ruleset knows the call is a proposal.
	const isProposed = (name: string) => evaluatePermission(ruleset, name) === "ask"

	let compactions = 0

	return AgentRuntime.stream(agent, input.text, {
		threadId: decodeThreadId(input.sessionId),
		history: Prompt.make(promptFromHistory(input.history)),
		// Not a budget: the ceilings live in the agent's policy. This is the only place the engine
		// reports token usage as it accrues — the event stream carries none — and `submit_diagnosis`
		// reads the running total mid-run, so a hook that merely observes is what fills it.
		budget: accumulateUsage(input.usage),
	}).pipe(
		// An abort clears the claim; the run notices at the next event rather than only after the
		// in-flight model call drains.
		Stream.takeWhile(() => input.holdsTurn()),
		Stream.runForEach((event) =>
			Effect.sync(() => {
				if (event._tag === "CompactionPerformed") compactions += 1
				for (const chat of toChatEvents(event, { messageId: input.messageId, isProposed })) {
					input.append(chat)
				}
			}),
		),
		Effect.map(
			(): ChatRunOutcome => ({
				autonomous: completion?.autonomous ?? false,
				submittedDiagnosis: completion?.submitted() ?? false,
				compactions,
			}),
		),
		// One provide, so the run's services share a lifetime. `ChatSession` is the history owner,
		// which is why the engine's is transient. A run is an entry point: the Durable Object
		// invocation owns this scope and nothing outside it composes these layers. The model's own
		// client stays in the requirements channel, where the Durable Object's runtime answers it.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(Layer.mergeAll(handlers, ThreadHistory.layerTransient, IdGenerator.layer)),
	)
}

const decodeThreadId = Schema.decodeSync(ThreadId)
