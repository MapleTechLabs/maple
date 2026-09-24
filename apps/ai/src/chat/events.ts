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
import { APPROVAL_REQUIRED } from "../mcp/tools/llm-tools"

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
	/** What a declared call is doing, for a reader; undefined for a tool that has no phrase. */
	readonly labelOf?: (toolName: string) => string | undefined
	/** One {@link makeTextSanitizer} per run: the state it keeps spans deltas. */
	readonly sanitizer: TextSanitizer
}

/**
 * Markup a model writes into `content` that is not for the reader.
 *
 * Two kinds, both seen in production. Thinking, when a model writes it inline as a tag instead of
 * on the reasoning channel `ReasoningDelta` already drops. And an unparsed tool call: denied tools
 * at the end of its budget, a model can emit its native tool-call markup as prose, and the provider
 * passes it through as text. Nothing downstream strips either — web happens to hide unknown tags
 * through its markdown sanitizer, a chat platform prints them verbatim.
 *
 * `leak` marks the tool-call ones, which are reported once per turn: a turn that answers with
 * markup is a turn that never answered, and the rate is what says whether that needs fixing
 * upstream rather than here.
 */
const HIDDEN_BLOCKS: ReadonlyArray<{
	readonly open: string
	readonly close: string
	readonly leak: boolean
}> = [
	{ open: "<think>", close: "</think>", leak: false },
	{ open: "<thinking>", close: "</thinking>", leak: false },
	{ open: "◁think▷", close: "◁/think▷", leak: false },
	{ open: "<|begin_of_thought|>", close: "<|end_of_thought|>", leak: false },
	{ open: "<tool_call>", close: "</tool_call>", leak: true },
	{ open: "<function_call>", close: "</function_call>", leak: true },
	{ open: "<|tool_call_begin|>", close: "<|tool_call_end|>", leak: true },
]

const LONGEST_OPEN = Math.max(...HIDDEN_BLOCKS.map(({ open }) => open.length))

/** How much of the tail could still grow into an opener, and so must not be emitted yet. */
const heldTail = (text: string): number => {
	for (let size = Math.min(LONGEST_OPEN - 1, text.length); size > 0; size--) {
		const tail = text.slice(-size)
		if (HIDDEN_BLOCKS.some(({ open }) => open.startsWith(tail))) return size
	}
	return 0
}

export interface TextSanitizer {
	/** One delta's text, with any hidden block removed. */
	readonly strip: (text: string) => string
	/**
	 * Whatever was still held when the turn ended, which is a tag that never arrived and so was
	 * only ever prose. Empty inside a block, where the text is markup the reader must not see.
	 */
	readonly flush: () => string
	/** The opening tag of the first tool call this turn wrote as text, if it wrote one. */
	readonly leaked: () => string | undefined
}

/**
 * A sanitizer for one turn.
 *
 * Stateful because a tag arrives split across deltas as readily as whole: text that could still
 * grow into an opener is held back until the next delta settles it. That costs at most the tail of
 * the final delta, so a turn ending on a bare `<` loses it — cheaper than the alternative, which
 * is half a tag reaching a channel because the other half had not arrived.
 */
export const makeTextSanitizer = (): TextSanitizer => {
	let buffer = ""
	let closing: (typeof HIDDEN_BLOCKS)[number] | undefined
	let leaked: string | undefined
	// The last character emitted, so a tag quoted across a delta boundary still reads as quoted.
	let previous = ""
	return {
		leaked: () => leaked,
		flush: () => {
			const held = closing === undefined ? buffer : ""
			buffer = ""
			return held
		},
		strip: (text) => {
			buffer += text
			let out = ""
			// Where to resume looking: past any opener the model merely quoted.
			let from = 0
			const emit = (value: string) => {
				if (value === "") return
				out += value
				previous = value.slice(-1)
			}
			for (;;) {
				if (closing !== undefined) {
					const end = buffer.indexOf(closing.close)
					// Nothing inside a block is emitted; keep only what could still close it. A block
					// the turn never closes takes the rest of the turn's text with it, which is what
					// an unparsed tool call at the end of a reply deserves.
					if (end === -1) {
						buffer = buffer.slice(Math.max(0, buffer.length - closing.close.length + 1))
						return out
					}
					buffer = buffer.slice(end + closing.close.length)
					closing = undefined
					from = 0
					continue
				}
				const opened = HIDDEN_BLOCKS.map((block) => ({
					at: buffer.indexOf(block.open, from),
					block,
				}))
					.filter(({ at }) => at !== -1)
					.sort((left, right) => left.at - right.at)[0]
				if (opened === undefined) {
					const held = heldTail(buffer)
					emit(buffer.slice(0, buffer.length - held))
					buffer = buffer.slice(buffer.length - held)
					return out
				}
				// A tag in a code span is the model talking ABOUT markup, which is prose — and the
				// style rules invite exactly that. Swallowing the rest of a reply over it would
				// turn a mention into the very silence this guards against.
				if ((opened.at === 0 ? previous : buffer[opened.at - 1]) === "`") {
					from = opened.at + opened.block.open.length
					continue
				}
				// The text before the block keeps its own held tail rather than being flushed
				// whole, so cutting out what sits between two halves of a tag cannot splice them
				// into a complete one on the way out.
				const before = buffer.slice(0, opened.at)
				emit(before.slice(0, before.length - heldTail(before)))
				buffer = buffer.slice(opened.at + opened.block.open.length)
				from = 0
				closing = opened.block
				if (opened.block.leak) leaked ??= opened.block.open
			}
		},
	}
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
	body:
		| { readonly type: "turn-start" }
		| { readonly type: "text-delta"; readonly text: string }
		| {
				readonly type: "turn-end"
				readonly reason: "stop" | "error" | "aborted" | "max-steps"
				readonly error?: string
		  },
): ReadonlyArray<ChatTurnEvent> => [
	{ ...body, messageId: event.toolCallId, task: childTask(event, context) } as ChatTurnEvent,
]

/**
 * The turn's last text, ahead of the event that ends it.
 *
 * What the sanitizer held back was a tag that never arrived, so it is prose after all and belongs
 * in the reply rather than lost to a turn that happened to end on a `<`.
 */
const flushed = (context: AdapterContext): ReadonlyArray<ChatTurnEvent> => {
	const text = context.sanitizer.flush()
	return text === "" ? [] : [tagged(context, { type: "text-delta", messageId: context.messageId, text })]
}

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

const optionalLabel = (label: string | undefined) => (label === undefined ? undefined : { label })

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
		case "TextDelta": {
			// Some providers stream an empty delta per reasoning token; a run wrote two thousand of
			// them into the session log in a minute, and the log is what every reconnect replays. A
			// delta that was nothing but hidden markup empties the same way.
			const text = context.sanitizer.strip(event.text)
			if (text === "") return []
			return [tagged(context, { type: "text-delta", messageId: context.messageId, text })]
		}
		case "ToolCallDeclared":
			return [
				tagged(context, {
					type: "tool-call",
					messageId: context.messageId,
					callId: event.toolCallId,
					name: event.toolName,
					input: event.parameters,
					...(context.isProposed?.(event.toolName) === true ? { proposed: true } : undefined),
					...optionalLabel(context.labelOf?.(event.toolName)),
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
			// The gate's refusal is not the proposal's result. Recorded as one, it read as a decision
			// everywhere a result settles a proposal: no connector drew the buttons, and every
			// approval was refused as already settled.
			if (event.errorTag === APPROVAL_REQUIRED) return []
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
				...flushed(context),
				tagged(context, {
					type: "turn-end",
					messageId: context.messageId,
					reason: completedReason(event.finishReason),
				}),
			]
		case "RunFailed":
			// A proposal is how the turn ends, not how it fails.
			if (event.errorTag === APPROVAL_REQUIRED) {
				return [
					...flushed(context),
					tagged(context, { type: "turn-end", messageId: context.messageId, reason: "stop" }),
				]
			}
			return [
				...flushed(context),
				tagged(context, {
					type: "turn-end",
					messageId: context.messageId,
					reason: "error",
					error: event.message,
				}),
			]
		case "RunInterrupted":
			return [
				...flushed(context),
				tagged(context, { type: "turn-end", messageId: context.messageId, reason: "aborted" }),
			]
		// Observable in traces, with no word on the wire.
		case "SubagentStarted":
			return childEvent(event, context, { type: "turn-start" })
		// Nothing emits this at `@effect-agent` 0.1.0-beta.85 — a delegation reports its lifecycle and
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
		// Maple's agents declare no typed updates.
		case "AgentUpdateEmitted":
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
