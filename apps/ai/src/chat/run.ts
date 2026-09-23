/**
 * Running one agent turn into a chat session.
 *
 * The seam between the engine and the Durable Object: this module builds the run, the Durable
 * Object owns ordering and the turn slot, and `turn-runner.ts` owns tenancy, metering and the turn
 * span. Nothing here decides *when* a tool is called — that is the engine's job now.
 */
import { evaluatePermission } from "@maple/domain/permission"
import type { ChatMessage, ChatTurnOrigin } from "@maple/domain/chat-session"
import * as AgentRuntime from "@effect-agent/engine/AgentRuntime"
import { ThreadHistory } from "@effect-agent/engine/ThreadHistory"
import { IdGenerator } from "@effect-agent/core/IdGenerator"
import { ThreadId } from "@effect-agent/core/Identifiers"
import { Effect, Layer, Schema, Stream } from "effect"
import { Prompt, Toolkit } from "effect/unstable/ai"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { agentSessionSpanAttributes, type ResolvedModel } from "../platform/Llm"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { type AgentDefinition, agentForSession, chatAgent } from "./agents"
import { profileForTurn } from "./profiles"
import { makeTextSanitizer, toChatEvents, type ChatTurnEvent } from "./events"
import {
	accumulateUsage,
	buildChatToolkit,
	buildDiagnosisCompletion,
	buildReplyCompletion,
	buildReviewCompletion,
	type RunCompletion,
	type RunUsage,
	type SubmitDiagnosis,
	type StageEdit,
	type SubmitReply,
	type SubmitReview,
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
	/** Who is driving this turn. Decides surface, ruleset, persona and labels — see `./profiles`. */
	readonly origin: ChatTurnOrigin
	readonly toolExecutor: McpToolExecutorApi
	readonly model: ResolvedModel
	readonly submitDiagnosis: SubmitDiagnosis
	/** Absent outside a review session's runtime; a `pr-` session without it runs with no completion. */
	readonly submitReview?: SubmitReview
	/** Absent outside a runtime that answers pull request comments. */
	readonly submitReply?: SubmitReply
	readonly stageEdit?: StageEdit
	/** This run is an autonomous pass's close-out: a report it files is a partial. */
	readonly closeOut?: boolean
	/** The agent to run as; defaults to the session's. The local review runner passes a variant. */
	readonly agent?: AgentDefinition
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
	/** This run was a machine-started pass: an investigation's or a review's. */
	readonly autonomous: boolean
	/** The run's completion tool (`submit_diagnosis`, `submit_review`) landed a report. */
	readonly submitted: boolean
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
	const agent = input.agent ?? agentForSession(input.sessionId)
	const profile = profileForTurn(agent, input.origin)
	const maple = buildChatToolkit(
		input.toolExecutor,
		input.tenant,
		profile.ruleset,
		profile.surface,
		agentSessionSpanAttributes(input.model.tags),
	)
	// One completion per session kind. The session id decides which, so a review session can never
	// be handed the diagnosis tool or the other way round.
	const completion: RunCompletion | undefined =
		buildDiagnosisCompletion(
			input.sessionId,
			input.tenant,
			input.origin,
			input.submitDiagnosis,
			input.usage,
			input.model.name,
			input.closeOut === true,
			agentSessionSpanAttributes(input.model.tags),
		) ??
		(input.submitReview === undefined
			? undefined
			: buildReviewCompletion(
					input.sessionId,
					input.tenant,
					input.origin,
					input.submitReview,
					input.usage,
					input.model.name,
					input.closeOut === true,
					agentSessionSpanAttributes(input.model.tags),
				)) ??
		(input.submitReply === undefined || input.stageEdit === undefined
			? undefined
			: buildReplyCompletion(
					input.sessionId,
					input.tenant,
					input.origin,
					input.submitReply,
					input.stageEdit,
					agentSessionSpanAttributes(input.model.tags),
				))

	const toolkit = Toolkit.merge(maple.toolkit, ...(completion === undefined ? [] : [completion.toolkit]))
	const handlers = Layer.mergeAll(maple.layer, ...(completion === undefined ? [] : [completion.layer]))

	// Declared but never *required*: see `buildDiagnosisCompletion`. A call still settles the run.
	const run = chatAgent({ ...agent, prompt: profile.prompt }, toolkit, input.model, {
		...(completion === undefined
			? undefined
			: { completion: { tool: completion.tool, required: false } }),
	})

	// A gated tool is announced exactly like any other and refuses when dispatched, so only the
	// ruleset knows the call is a proposal.
	const isProposed = (name: string) => evaluatePermission(profile.ruleset, name) === "ask"

	let compactions = 0
	// One per turn: a hidden block straddles deltas, so the state that finds it has to as well.
	const sanitizer = makeTextSanitizer()

	return AgentRuntime.stream(run, input.text, {
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
				for (const chat of toChatEvents(event, {
					messageId: input.messageId,
					isProposed,
					sanitizer,
				})) {
					input.append(chat)
				}
			}),
		),
		// Once per turn, the tag alone: a model that wrote a tool call as prose answered with
		// nothing, and how often that happens is a question about the run's ending, not this turn.
		// `ensuring`, not `tap`, because a run that leaked and then failed is the interesting one.
		Effect.ensuring(
			Effect.suspend(() => {
				const leaked = sanitizer.leaked()
				return leaked === undefined
					? Effect.void
					: Effect.logWarning("Model wrote a tool call as text").pipe(
							Effect.annotateLogs({ leakedTag: leaked }),
						)
			}),
		),
		Effect.map(
			(): ChatRunOutcome => ({
				autonomous: completion?.autonomous ?? false,
				submitted: completion?.submitted() ?? false,
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
