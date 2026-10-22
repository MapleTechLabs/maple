/**
 * Running one agent turn into a chat session.
 *
 * The seam between the engine and the Durable Object: this module builds the run, the Durable
 * Object owns ordering and the turn slot, and `turn-runner.ts` owns tenancy, metering and the turn
 * span. Nothing here decides *when* a tool is called — that is the engine's job now.
 */
import { evaluatePermission } from "@maple/domain/permission"
import type { ChatMessage, ChatTurnOrigin } from "@maple/domain/chat-session"
import * as AgentRuntime from "@yielded/agent/agent-runtime"
import type { CodeExecutor } from "@yielded/agent/code-executor"
import type { RunBudgetHook } from "@yielded/agent/run-options"
import type * as RunEvent from "@yielded/agent/run-event"
import * as ThreadHistory from "@yielded/agent/thread-history"
import { ThreadId } from "@yielded/agent/identifiers"
import { Cause, Clock, Duration, Effect, Layer, Schema, Stream } from "effect"
import { Prompt, Toolkit } from "effect/ai"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { ApprovalRequired, type ToolUiPayload } from "../mcp/tools/llm-tools"
import { mapleToolPhrase } from "../mcp/tools/registry"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"
import { agentSessionSpanAttributes, type ResolvedModel } from "../platform/Llm"
import { withRunSessionAttributes } from "../platform/genai-spans"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { type AgentDefinition, agentForSession, chatAgent } from "./agents"
import { profileForTurn } from "./profiles"
import { makeTextSanitizer, settledTurnEnd, toChatEvents, type ChatTurnEvent } from "./events"
import { makeReviewCoverage, type ReviewCoverage } from "./review-coverage"
import type { ReviewLedger } from "./review-ledger"
import { buildReviewFanout } from "./review-fanout"
import { buildCodeMode, CODE_MODE_GUIDANCE, CODE_MODE_TOOLS } from "./code-mode"
import {
	accumulateUsage,
	buildChatToolkit,
	buildDiagnosisCompletion,
	buildReplyCompletion,
	buildReviewCompletion,
	isAutonomousReviewTurn,
	type RunCompletion,
	SUBMIT_REVIEW,
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
	/**
	 * A review turn's own state, shared by its pass and its close-out: what was read, and the
	 * findings saved so far. Absent, a review run makes its own coverage and offers no `record_finding`.
	 */
	readonly review?: ReviewTurnState
	/** The agent to run as; defaults to the session's. The local review runner passes a variant. */
	readonly agent?: AgentDefinition
	/** Runs `run_code` programs for an agent that offers it; absent, the tool is not offered. */
	readonly codeExecutor?: Layer.Layer<CodeExecutor>
	/** The message the user just sent, which is this run's input. */
	readonly text: string
	readonly history: ReadonlyArray<ChatMessage>
	/** Accumulated across the run; `submit_diagnosis` reads it mid-run. */
	readonly usage: RunUsage
	/** False once the turn slot has been released, which stops the run writing into a moved-on session. */
	readonly holdsTurn: () => boolean
	readonly append: (event: ChatTurnEvent) => void
}

export interface ReviewTurnState {
	readonly coverage: ReviewCoverage
	readonly ledger: ReviewLedger
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
export const runChatTurn = (input: ChatRunInput) =>
	Clock.currentTimeMillis.pipe(Effect.flatMap((startedAt) => runChatTurnFrom(input, startedAt)))

const runChatTurnFrom = (input: ChatRunInput, startedAt: number) => {
	const agent = input.agent ?? agentForSession(input.sessionId)
	const profile = profileForTurn(agent, input.origin)
	// Per run, and fed by the Maple handlers the review_files children share, so a group a child
	// read counts as read.
	const coverage = isAutonomousReviewTurn(input.sessionId, input.origin)
		? (input.review?.coverage ?? makeReviewCoverage(input.text))
		: undefined
	// A call's UI payload, held until its result event is written. Never part of what the model reads.
	const uiByCall = new Map<string, ToolUiPayload>()
	const sessionAttributes = agentSessionSpanAttributes(input.model.tags)
	const maple = buildChatToolkit(
		input.toolExecutor,
		input.tenant,
		profile.ruleset,
		profile.surface,
		sessionAttributes,
		coverage?.observe,
		(toolCallId, ui) => uiByCall.set(toolCallId, ui),
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
			sessionAttributes,
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
					sessionAttributes,
					coverage,
					input.review?.ledger,
				)) ??
		(input.submitReply === undefined || input.stageEdit === undefined
			? undefined
			: buildReplyCompletion(
					input.sessionId,
					input.tenant,
					input.origin,
					input.submitReply,
					input.stageEdit,
					sessionAttributes,
				))

	// Read-only tools only: a program cannot hold a proposal for approval, and a write it made before
	// failing could not be retried safely.
	const codeMode =
		agent.codeMode === true && input.codeExecutor !== undefined
			? buildCodeMode(
					Object.fromEntries(
						Object.entries(maple.toolkit.tools).filter(
							([name]) =>
								CODE_MODE_TOOLS.has(name) &&
								evaluatePermission(profile.ruleset, name) === "allow" &&
								!MUTATING_TOOL_NAMES.has(name),
						),
					),
					maple.layer,
					input.codeExecutor,
				)
			: undefined

	// A review's own pass may hand groups of a large pull request's files to child reviewers, who
	// read with the same tools, `run_code` included.
	const fanout =
		completion?.tool === SUBMIT_REVIEW && completion.autonomous
			? buildReviewFanout(
					Toolkit.merge(maple.toolkit, ...(codeMode === undefined ? [] : [codeMode.toolkit])),
					input.model,
					startedAt + Duration.toMillis(Duration.fromInputUnsafe(agent.budget.maxDuration)),
					codeMode === undefined ? undefined : CODE_MODE_GUIDANCE,
				)
			: undefined

	const toolkit = Toolkit.merge(
		maple.toolkit,
		...(completion === undefined ? [] : [completion.toolkit]),
		...(fanout === undefined ? [] : [fanout.toolkit]),
		...(codeMode === undefined ? [] : [codeMode.toolkit]),
	)
	const handlers = Layer.mergeAll(
		maple.layer,
		...(completion === undefined ? [] : [completion.layer]),
		...(codeMode === undefined ? [] : [codeMode.layer]),
		// The children run the parent's own tool handlers, so those are provided into the fan-out.
		...(fanout === undefined
			? []
			: [
					fanout.layer.pipe(
						Layer.provide(
							codeMode === undefined ? maple.layer : Layer.merge(maple.layer, codeMode.layer),
						),
					),
				]),
	)

	// Not declared to the engine, which would then require the tool on every call; see
	// `buildDiagnosisCompletion`. A landed submission still settles the run, below.
	const prompt = codeMode === undefined ? profile.prompt : `${profile.prompt}\n\n${CODE_MODE_GUIDANCE}`
	const run = chatAgent({ ...agent, prompt }, toolkit, input.model, {
		autonomous: input.origin.kind === "autonomous",
	})
	const usage = accumulateUsage(input.usage)
	const submitted = () => completion?.submitted() === true
	const budget: RunBudgetHook = {
		...usage,
		// A landed submission settles the run: the next model pull after its batch never starts. An
		// interrupt rather than a failure, so a settled run records no error.
		guard: (effect) => (submitted() ? Effect.interrupt : usage.guard(effect)),
	}

	// A gated tool is announced exactly like any other and refuses when dispatched, so only the
	// ruleset knows the call is a proposal.
	const isProposed = (name: string) => evaluatePermission(profile.ruleset, name) === "ask"

	let compactions = 0
	// One per turn: a hidden block straddles deltas, so the state that finds it has to as well.
	const sanitizer = makeTextSanitizer()
	const context = {
		messageId: input.messageId,
		isProposed,
		labelOf: mapleToolPhrase,
		uiOf: (toolCallId: string) => {
			const ui = uiByCall.get(toolCallId)
			uiByCall.delete(toolCallId)
			return ui
		},
		sanitizer,
	}
	// Once the submission lands, the run's own ending (the guard's interrupt) is not the turn's.
	const settledTerminal = (event: RunEvent.RunEvent) =>
		submitted() &&
		(event._tag === "RunCompleted" || event._tag === "RunFailed" || event._tag === "RunInterrupted")

	return AgentRuntime.stream(run, input.text, {
		threadId: decodeThreadId(input.sessionId),
		history: Prompt.make(promptFromHistory(input.history)),
		// Not a budget: the ceilings live in the agent's policy. This is the only place the engine
		// reports token usage as it accrues — the event stream carries none — and `submit_diagnosis`
		// reads the running total mid-run, so a hook that merely observes is what fills it.
		budget,
	}).pipe(
		// An abort clears the claim; the run notices at the next event rather than only after the
		// in-flight model call drains.
		Stream.takeWhile(() => input.holdsTurn()),
		Stream.runForEach((event) =>
			Effect.sync(() => {
				if (event._tag === "CompactionPerformed") compactions += 1
				if (settledTerminal(event)) return
				for (const chat of toChatEvents(event, context)) input.append(chat)
			}),
		),
		// The gate's refusal is how a run stops on a proposal: the turn finished, it did not fail.
		Effect.catchIf(
			(error) => error instanceof ApprovalRequired,
			() => Effect.void,
		),
		// A landed submission makes any later failure moot, defects included; only an abort stays one.
		Effect.catchCause((cause) =>
			!submitted() || !input.holdsTurn()
				? Effect.failCause(cause)
				: Cause.hasInterruptsOnly(cause)
					? Effect.void
					: Effect.logWarning("Run failed after its submission landed").pipe(
							Effect.annotateLogs({ cause: summarizeCause(cause) }),
						),
		),
		Effect.tap(() =>
			Effect.sync(() => {
				if (submitted() && input.holdsTurn())
					for (const chat of settledTurnEnd(context)) input.append(chat)
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
		Effect.map((): ChatRunOutcome => ({
			autonomous: completion?.autonomous ?? false,
			submitted: completion?.submitted() ?? false,
			compactions,
		})),
		// One provide, so the run's services share a lifetime. `ChatSession` is the history owner,
		// which is why the engine's lives only for this provide. A run is an entry point: the Durable Object
		// invocation owns this scope and nothing outside it composes these layers. The model's own
		// client stays in the requirements channel, where the Durable Object's runtime answers it.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(Layer.mergeAll(handlers, ThreadHistory.layer)),
		// The `review_files` children run on threads of their own; their spans still belong to this
		// session, so one review is one session.
		(run) =>
			Effect.flatMap(Effect.tracer, (tracer) =>
				Effect.withTracer(run, withRunSessionAttributes(tracer, sessionAttributes)),
			),
	)
}

const decodeThreadId = Schema.decodeSync(ThreadId)
