/**
 * `ChatEvent` log → `ChatMessage` transcript.
 *
 * Deriving rather than storing messages keeps one source of truth: an event log that replays
 * identically wherever it is read. Text deltas concatenate; tool calls attach to the assistant
 * message that issued them and are completed in place by their result.
 *
 * The fold lives here rather than in the `ChatSession` Durable Object because two things need it
 * and must not disagree: the object's `history()` replays the stored log through it on a cold
 * load, and a consumer tailing the live event stream — a chat-platform bot — folds the same
 * events into the same messages without waiting for a history read.
 */
import type { ChatEvent, ChatMessage, ChatTaskRef, ChatTaskState, ChatToolCall } from "./chat-session"

/**
 * A transcript being folded, event by event.
 *
 * Incremental rather than a one-shot `fold(events)`: a live tail has no end, and re-folding the
 * whole log per arriving event is quadratic in a turn that streams hundreds of deltas.
 */
export interface ChatTranscript {
	/** Fold one event. Events must arrive in `seq` order; `createdAt` is epoch ms. */
	readonly add: (event: ChatEvent, createdAt: number) => void
	/** The transcript so far — the live array the fold appends to, not a copy. */
	readonly messages: ReadonlyArray<ChatMessage>
}

export const makeChatTranscript = (): ChatTranscript => {
	const top = makeDrafts()
	/** Nested transcripts by task call id, owned by this transcript. */
	const nested = new Map<string, Drafts>()
	return {
		messages: top.messages,
		add: (event, createdAt) => {
			// A task-tagged event belongs to a sub-agent's transcript, which hangs off the parent's
			// `task` tool call — not to the top-level conversation. Routing it here is what keeps a
			// fan-out of sub-agents from appearing as a dozen stray assistant messages, in the
			// browser *and* in what `toLlmMessages` replays to the model on the next turn.
			if (event.type !== "user-message" && event.task !== undefined) {
				foldTaskEvent(top, nested, event, event.task, createdAt)
				return
			}
			foldInto(top, event, createdAt)
		},
	}
}

/**
 * A mutable mirror of `ChatMessage`.
 *
 * The fold concatenates deltas and completes tool calls in place; building it against the readonly
 * wire type would force a copy per delta, which is exactly the form that used to desynchronise
 * `byId` from `messages`.
 */
interface Draft {
	id: string
	role: ChatMessage["role"]
	text: string
	toolCalls: Array<ChatToolCall>
	createdAt: number
	startSeq: number
}

interface Drafts {
	readonly messages: Array<Draft>
	readonly byId: Map<string, Draft>
}

const makeDrafts = (): Drafts => ({ messages: [], byId: new Map() })

const openAssistant = (drafts: Drafts, id: string, createdAt: number, startSeq: number): Draft => {
	const existing = drafts.byId.get(id)
	if (existing) return existing
	const message: Draft = { id, role: "assistant", text: "", toolCalls: [], createdAt, startSeq }
	drafts.byId.set(id, message)
	drafts.messages.push(message)
	return message
}

/**
 * Fold one event into a set of drafts.
 *
 * Extracted so the top-level conversation and a sub-agent's nested transcript are folded by
 * *literally the same code* — two implementations of "concatenate deltas, settle tool calls in
 * place" would drift, and the nested one is the harder to notice when it does.
 */
const foldInto = (drafts: Drafts, event: ChatEvent, createdAt: number): void => {
	const open = (messageId: string) => openAssistant(drafts, messageId, createdAt, event.seq)
	switch (event.type) {
		case "user-message": {
			const message: Draft = {
				id: event.id,
				role: "user",
				text: event.text,
				toolCalls: [],
				createdAt,
				startSeq: event.seq,
			}
			drafts.byId.set(event.id, message)
			drafts.messages.push(message)
			break
		}
		case "turn-start":
			open(event.messageId)
			break
		case "text-delta": {
			// Mutate in place. Replacing the array slot with a copy left `byId` pointing at an
			// object no longer in `messages`, so the *next* delta opened a brand-new assistant
			// message — a 400-token reply folded into ~400 one-token messages, in what the browser
			// rendered and in what the model was replayed on the next turn.
			open(event.messageId).text += event.text
			break
		}
		case "tool-call": {
			const message = open(event.messageId)
			message.toolCalls.push({
				id: event.callId,
				name: event.name,
				input: event.input,
				// Where the prose stood when the model asked for this call. `ChatMessage` keeps text
				// and calls in two flat fields, so this offset is the only record of how the turn
				// actually unfolded — the client re-interleaves from it on a cold load.
				textOffset: message.text.length,
				...(event.proposed === true ? { proposed: true } : undefined),
			} as ChatToolCall)
			break
		}
		case "tool-result": {
			const message = open(event.messageId)
			const index = message.toolCalls.findIndex((call) => call.id === event.callId)
			if (index >= 0) {
				message.toolCalls[index] = {
					...message.toolCalls[index],
					output: event.output,
					...(event.isError === true ? { isError: true } : undefined),
				} as ChatToolCall
			}
			break
		}
		case "turn-retry": {
			// Undo the text of the attempt that failed. The clamp is not defensive noise:
			// `Stream.takeWhile(holdsTurn)` in `turn-runner.ts` can drop appends between a delta and
			// the retraction that accounts for it, so `retractChars` can legitimately exceed what
			// actually landed.
			const message = open(event.messageId)
			message.text = message.text.slice(0, Math.max(0, message.text.length - event.retractChars))
			break
		}
		case "turn-end":
			break
	}
}

/** Terminal reason → the status the UI shows on the sub-agent's card. */
const TASK_STATUS: Record<string, ChatTaskState["status"]> = {
	stop: "completed",
	error: "error",
	aborted: "aborted",
	"max-steps": "aborted",
} satisfies Record<string, ChatTaskState["status"]>

/**
 * Route one sub-agent event into the transcript hanging off its parent's `task` tool call.
 *
 * **Deny by default.** If the parent message or the parent tool call is not found, the event is
 * dropped. That is the guarantee that a malformed or out-of-order child event cannot corrupt the
 * parent conversation — and it costs nothing in practice, because the parent's `tool-call`
 * announcement is appended strictly before the tool's `execute` runs.
 */
const foldTaskEvent = (
	top: Drafts,
	nested: Map<string, Drafts>,
	event: ChatEvent,
	ref: ChatTaskRef,
	createdAt: number,
): void => {
	const parent = top.byId.get(ref.parentMessageId)
	if (!parent) return
	const index = parent.toolCalls.findIndex((call) => call.id === ref.id)
	if (index < 0) return

	const child = nested.get(ref.id) ?? makeDrafts()
	nested.set(ref.id, child)
	foldInto(child, event, createdAt)

	// `ChatToolCall` is the readonly wire type, so the call is rebuilt rather than mutated. Keying
	// the nested transcript by task id rather than by object identity is what makes that safe.
	parent.toolCalls[index] = {
		...parent.toolCalls[index],
		task: {
			id: ref.id,
			agent: ref.agent,
			status: event.type === "turn-end" ? (TASK_STATUS[event.reason] ?? "completed") : "running",
			// The nested drafts are structurally `ChatSubMessage` already — a sub-agent cannot nest
			// further, so no `task` field is ever present on them.
			messages: child.messages,
		},
	} as ChatToolCall
}
