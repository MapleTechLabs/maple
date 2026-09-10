/**
 * The wire contract, in one place.
 *
 * Everything the browser and the iOS app badge on is decided here: which engine events become
 * durable chat events, what a sub-agent's events are tagged with, and which terminal reason a run
 * ends on. The Durable Object assigns `seq`; this module never does.
 *
 * Deliberately total over the engine's event union rather than a filtered switch: a new event
 * variant should make this file fail to compile, not silently vanish from the transcript.
 */
import type { ChatEvent, ChatTaskRef } from "@maple/domain/chat-session"
import type * as RunEvent from "@effect-agent/core/RunEvent"

/** Events the session log accepts. `seq` belongs to the Durable Object, which owns the ordering. */
type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never
export type ChatTurnEvent = WithoutSeq<Exclude<ChatEvent, { type: "user-message" }>>

export interface AdapterContext {
	/** The assistant message this run is writing into, assigned by the Durable Object. */
	readonly messageId: string
	/** Set when the run is a sub-agent: routes its events into the parent's task card. */
	readonly task?: ChatTaskRef
	/**
	 * Whether a declared call is a *proposal* rather than a dispatch.
	 *
	 * The gate lives with the toolkit, not with the engine: an approval-gated tool keeps a real
	 * schema and a handler that refuses, so the call is announced exactly like any other and only
	 * this predicate knows it will not run. `ApprovalRequested` cannot answer it — that event
	 * carries no parameters, and the card needs the arguments the declaration already delivered.
	 */
	readonly isProposed?: (toolName: string) => boolean
}

/**
 * The card a sub-agent's events hang off.
 *
 * `id` is the parent's delegation tool call, which is what `ChatSession` looks the card up by — so
 * an event whose call id does not match a `tool-call` already in the transcript is dropped rather
 * than corrupting the parent conversation.
 */
const childTask = (
	event: { readonly toolCallId: string; readonly targetAgentId: string },
	context: AdapterContext,
): ChatTaskRef => ({
	id: event.toolCallId,
	agent: event.targetAgentId,
	parentMessageId: context.messageId,
})

/**
 * A sub-agent's own events are its own.
 *
 * The engine keeps a child's tool history and working notes in the child's thread and relays only
 * its lifecycle, so the card shows that the sub-agent ran and how it ended — never a live replay of
 * it searching. Its answer arrives separately, as the result of the delegation call on the parent's
 * message. `messageId` is that call's id, which is what gives the card its own message to fold
 * into.
 */
const childEvent = (
	event: { readonly toolCallId: string; readonly targetAgentId: string },
	context: AdapterContext,
	body: { readonly type: "turn-start" } | { readonly type: "text-delta"; readonly text: string } | {
		readonly type: "turn-end"
		readonly reason: "stop" | "error" | "aborted" | "max-steps"
		readonly error?: string
	},
): ReadonlyArray<ChatTurnEvent> => [
	{ ...body, messageId: event.toolCallId, task: childTask(event, context) } as ChatTurnEvent,
]

/** Stamp an event with the ref that routes it into a parent's task card. */
const tagged = <E extends ChatTurnEvent>(context: AdapterContext, event: E): E =>
	context.task === undefined ? event : { ...event, task: context.task }

/**
 * How a completed run's finish reason reads on the wire.
 *
 * `budget-exhausted` is the old `max-steps`: the run spent its turns and answered from what it had.
 * Everything else that completed is a normal stop.
 */
const completedReason = (finishReason: string): "stop" | "max-steps" =>
	finishReason === "budget-exhausted" ? "max-steps" : "stop"

/**
 * One engine event as zero or more chat events.
 *
 * Zero for everything the wire has no word for — turn boundaries, reasoning deltas, tool progress,
 * budget warnings — which are observable in traces rather than in the transcript.
 */
export const toChatEvents = (
	event: RunEvent.RunEvent,
	context: AdapterContext,
): ReadonlyArray<ChatTurnEvent> => {
	switch (event._tag) {
		case "RunStarted":
			return [tagged(context, { type: "turn-start", messageId: context.messageId })]
		case "TextDelta":
			return [
				tagged(context, { type: "text-delta", messageId: context.messageId, text: event.text }),
			]
		case "ToolCallDeclared":
			return [
				tagged(context, {
					type: "tool-call",
					messageId: context.messageId,
					callId: event.toolCallId,
					name: event.toolName,
					input: event.parameters,
					...(context.isProposed?.(event.toolName) === true ? { proposed: true } : undefined),
				}),
			]
		case "ToolCallSucceeded":
			return [
				tagged(context, {
					type: "tool-result",
					messageId: context.messageId,
					callId: event.toolCallId,
					output: event.result,
				}),
			]
		case "ToolCallFailed":
			return [
				tagged(context, {
					type: "tool-result",
					messageId: context.messageId,
					callId: event.toolCallId,
					output: event.message,
					isError: true,
				}),
			]
		case "RunCompleted":
			return [
				tagged(context, {
					type: "turn-end",
					messageId: context.messageId,
					reason: completedReason(event.finishReason),
				}),
			]
		case "RunFailed":
			return [
				tagged(context, {
					type: "turn-end",
					messageId: context.messageId,
					reason: "error",
					error: event.message,
				}),
			]
		case "RunInterrupted":
			return [tagged(context, { type: "turn-end", messageId: context.messageId, reason: "aborted" })]
		// Observable in traces, with no word on the wire.
		case "SubagentStarted":
			return childEvent(event, context, { type: "turn-start" })
		// Nothing emits this at `@effect-agent` 0.1.0-beta.74 — a delegation reports its lifecycle and
		// its result, not its progress. Mapped anyway so the day one arrives it lands on the card
		// instead of being silently dropped by a filtered switch.
		case "SubagentProgress":
			return childEvent(event, context, { type: "text-delta", text: event.summary })
		case "SubagentCompleted":
			return childEvent(event, context, {
				type: "turn-end",
				reason: completedReason(event.finishReason),
			})
		case "SubagentFailed":
			return childEvent(event, context, {
				type: "turn-end",
				reason: "error",
				error: event.message,
			})
		case "SubagentInterrupted":
			return childEvent(event, context, { type: "turn-end", reason: "aborted" })
		case "ApprovalRequested":
		case "TurnStarted":
		case "ModelStarted":
		case "ReasoningDelta":
		case "ToolCallStarted":
		case "ToolProgress":
		case "TurnCompleted":
		case "BudgetWarning":
		case "CompactionPerformed":
		case "RunSuspended":
		// `Requested` precedes the delegation tool call that opens the card; `Joined` follows the
		// result that closes it. Both would render as a duplicate of an event already sent.
		case "SubagentRequested":
		case "SubagentJoined":
			return []
	}
}
