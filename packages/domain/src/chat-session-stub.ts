// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
/**
 * Reaching a chat session's Durable Object.
 *
 * Separate from the wire contract because this is the one place the object is
 * addressed rather than described, and addressing it means handling a namespace
 * handle off a Worker env — a value nothing has parsed yet.
 *
 * Both Workers need it: the one that hosts the class, and `apps/api`, which holds
 * a cross-script reference to it. Keeping the shape in one place is what makes
 * that reference structurally safe.
 */
import type {
	ChatEvent,
	ChatEventInput,
	ChatMessage,
	ChatProposalOutcome,
	ChatProposalSettlement,
	ChatTurnOrigin,
	ChatTurnTenantEncoded,
} from "./chat-session"

/**
 * The `ChatSession` Durable Object's RPC surface, and how to reach it off a Worker env.
 *
 * This lives in the domain rather than beside the object because both Workers need it: the one
 * that hosts the class, and `apps/api`, which holds a cross-script reference to it. Keeping the
 * shape in one place is what makes that reference structurally safe.
 */
export interface ChatSessionStub {
	readonly cursor: () => Promise<number>
	readonly running: () => Promise<boolean>
	readonly history: () => Promise<ReadonlyArray<ChatMessage>>
	readonly since: (cursor: number) => Promise<ReadonlyArray<ChatEvent>>
	/**
	 * Replay from `cursor` then stay open, as pre-framed SSE bytes.
	 *
	 * One RPC per connection rather than one per batch — see `ChatSession.subscribe`. Workers RPC
	 * carries a `ReadableStream` by reference, so the frames the DO writes reach the client without
	 * another hop through this stub.
	 */
	readonly subscribe: (cursor: number) => Promise<ReadableStream<Uint8Array>>
	readonly append: (event: ChatEventInput) => Promise<number>
	readonly beginTurn: (input: {
		readonly sessionId: string
		readonly messageId: string
		readonly text: string
		readonly tenant: ChatTurnTenantEncoded
		/** Who is driving the turn, stated by whoever raised it. */
		readonly origin: ChatTurnOrigin
	}) => Promise<
		| {
				cursor: number
				messageId: string
				/**
				 * The assistant message this turn writes, which is not the user message's id.
				 *
				 * Every event the turn emits carries it, so a caller that renders the turn itself — a
				 * chat connector relaying it into a channel — needs it to tell this turn's events from
				 * a replayed earlier one's. A caller that folds the whole transcript does not.
				 */
				turnMessageId: string
		  }
		| undefined
	>
	/**
	 * Apply or decline a mutation the agent proposed, and record the outcome as that call's
	 * `tool-result`.
	 *
	 * By reference: the caller names the call, and the session reads the tool's name and arguments
	 * out of its own log. A caller that could name them would be a second way to run a mutating
	 * tool, reachable by anyone who can reach this object.
	 *
	 * The object is the single writer, so the second click on the same control is answered
	 * `"settled"` rather than racing the first one's execution.
	 */
	readonly settleProposal: (input: ChatProposalSettlement) => Promise<ChatProposalOutcome>
	readonly holdsTurn: (messageId: string) => Promise<boolean>
	readonly endTurn: (messageId: string) => Promise<void>
	readonly abort: () => Promise<void>
}

export interface ChatSessionNamespace {
	readonly idFromName: (name: string) => unknown
	readonly get: (id: unknown) => ChatSessionStub
}

export const isChatSessionNamespace = (value: unknown): value is ChatSessionNamespace =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { get?: unknown }).get === "function" &&
	typeof (value as { idFromName?: unknown }).idFromName === "function"

/** Resolve the `ChatSession` binding (the Durable Object's alchemy name) off a worker env record, or `undefined` if it is missing. */
export const chatSessionStub = (
	env: Record<string, unknown>,
	sessionId: string,
): ChatSessionStub | undefined => {
	const namespace = env.ChatSession
	if (!isChatSessionNamespace(namespace)) return undefined
	return namespace.get(namespace.idFromName(sessionId))
}
