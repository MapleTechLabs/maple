import type { AiServiceError } from "@maple/domain/ai-service"
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
import type { ToolExecutorApi } from "../runtime/tool-executor"
import type { ResolvedModel } from "../platform/Llm"
import type { ChatTurnTenant as TenantContext } from "@maple/domain/chat-session"
import { agentForSession } from "./session-agent"
import { investigationIdForSession } from "@maple/domain/ai-investigation-context"
import { textAgent } from "../runtime/agent"
import { buildDelegation } from "../runtime/delegation"
import { toChatEvents, type ChatTurnEvent } from "./events"
import {
	buildDiagnosisCompletion,
	SUBMIT_DIAGNOSIS,
	type SubmitDiagnosis,
} from "../investigations/completion"
import { accumulateUsage, type RunUsage } from "../runtime/usage"
import { buildAgentToolkit } from "../runtime/tools"

/**
 * The transcript the model starts from.
 *
 * Supplied as run options rather than retained by the engine: `ChatSession` is the authority on what
 * was said, and a second history owner would be a second answer to the same question. A compaction
 * replaces everything up to its `throughSeq` with its summary, exactly as before.
 */
export const promptFromHistory = (
	history: ReadonlyArray<ChatMessage>,
	compaction?: { readonly summary: string; readonly throughSeq: number },
): ReadonlyArray<PromptMessage> => {
	const spoken = (
		compaction === undefined
			? history
			: history.filter((message) => message.startSeq > compaction.throughSeq)
	).filter((message) => message.text.trim() !== "")

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

	const messages = kept.map((message) => ({
		role: message.role === "user" ? ("user" as const) : ("assistant" as const),
		content: [{ type: "text" as const, text: message.text }],
	}))
	return compaction === undefined
		? messages
		: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: COMPACTION_PREAMBLE + compaction.summary }],
				},
				...messages,
			]
}

/** One replayed turn, in the shape `Prompt.make` accepts. */
export interface PromptMessage {
	readonly role: "user" | "assistant"
	readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
}

const MAX_REPLAYED_MESSAGES = 40
const MAX_REPLAYED_CHARS = 60_000

/** How the summary is introduced to the model. */
const COMPACTION_PREAMBLE = "Summary of the earlier part of this conversation, which has been condensed:\n\n"

export interface ChatRunInput {
	readonly sessionId: string
	readonly messageId: string
	readonly tenant: TenantContext
	readonly toolExecutor: ToolExecutorApi
	readonly model: ResolvedModel
	/** The model sub-agents run on. Defaults to the conversation's own. */
	readonly subagentModel?: ResolvedModel
	readonly submitDiagnosis: SubmitDiagnosis
	/** The message the user just sent, which is this run's input. */
	readonly text: string
	readonly history: ReadonlyArray<ChatMessage>
	readonly compaction?: { readonly summary: string; readonly throughSeq: number }
	/** Accumulated across the run; `submit_diagnosis` reads it mid-run. */
	readonly usage: RunUsage
	/** False once the turn slot has been released, which stops the run writing into a moved-on session. */
	readonly holdsTurn: () => boolean
	readonly append: (events: ReadonlyArray<ChatTurnEvent>) => Effect.Effect<void, AiServiceError>
}

/**
 * Build and drain one run.
 *
 * The returned Effect settles when the run does. Every chat event it produces has already been
 * appended by the time it settles, and the terminal reason is whatever the engine reported — this
 * module never invents one.
 */
export const runChatTurn = (input: ChatRunInput) => {
	const definition = agentForSession(input.sessionId, input.toolExecutor.tools)
	const ruleset = definition.permission
	const maple = buildAgentToolkit(input.toolExecutor, ruleset)
	const completion = buildDiagnosisCompletion(
		investigationIdForSession(input.sessionId),
		input.tenant,
		input.submitDiagnosis,
		input.usage,
		input.model.name,
	)

	// The sub-agents this agent may spawn, as delegation tools. `undefined` for an agent that
	// spawns none, which is most of them — the capability is opt-in per agent rather than a tool
	// every turn carries and refuses.
	const delegation = buildDelegation(
		definition,
		input.toolExecutor,
		input.model,
		input.subagentModel ?? input.model,
	)

	const toolkit = Toolkit.merge(
		maple.toolkit,
		...(completion === undefined ? [] : [completion.toolkit]),
		...(delegation === undefined ? [] : [delegation.toolkit]),
	)
	const handlers = Layer.mergeAll(
		maple.layer,
		...(completion === undefined ? [] : [completion.layer]),
		...(delegation === undefined ? [] : [delegation.layer]),
	)

	const agent = textAgent(definition, toolkit, input.model, {
		...(completion === undefined
			? undefined
			: { completion: { tool: SUBMIT_DIAGNOSIS, required: completion.required } }),
	})

	// A gated tool is announced exactly like any other and refuses when dispatched, so only the
	// ruleset knows the call is a proposal.
	const isProposed = (name: string) => evaluatePermission(ruleset, name) === "ask"

	return AgentRuntime.stream(agent, input.text, {
		threadId: decodeThreadId(input.sessionId),
		history: Prompt.make(promptFromHistory(input.history, input.compaction)),
		// Not a budget: the ceilings live in the agent's policy. This is the only place the engine
		// reports token usage as it accrues — the event stream carries none — and `submit_diagnosis`
		// reads the running total mid-run, so a hook that merely observes is what fills it.
		budget: accumulateUsage(input.usage),
	}).pipe(
		// An abort clears the claim; the run notices at the next event rather than only after the
		// in-flight model call drains.
		Stream.takeWhile(() => input.holdsTurn()),
		Stream.groupedWithin(32, "20 millis"),
		Stream.runForEach((events) =>
			input.append(
				events.flatMap((event) => toChatEvents(event, { messageId: input.messageId, isProposed })),
			),
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
