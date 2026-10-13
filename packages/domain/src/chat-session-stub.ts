/**
 * Reaching a chat session's Durable Object.
 *
 * Every Worker that addresses the object needs these shapes: maple-ai, which hosts the class, and
 * api, alerting and chat-bot, which hold a cross-script binding to it. Keeping them in one place
 * is what keeps those bindings structurally safe.
 */
import { Effect, Schema, Stream } from "effect"
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
/**
 * The `ChatSession` Durable Object's RPC surface, as the object answers it over Workers RPC.
 *
 * The wire contract: `ChatSessionRpc` lifts it to the Effects the host serves, and
 * `ChatSessionClient` is what a caller holds.
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

/** The stub's surface with each method's Promise lifted to an Effect. */
type EffectSurface<Stub, E> = {
	readonly [K in keyof Stub]: Stub[K] extends (...args: infer Args) => Promise<infer Result>
		? (...args: Args) => Effect.Effect<Result, E>
		: never
}

/**
 * What the object serves, one Effect per method, which alchemy's bridge runs per RPC call, plus the
 * heartbeat alarm it dispatches as the object's `alarm`. Also the shape alchemy's namespace client
 * types its stubs with, so it is typed for the caller's side too: a call can fail across the RPC
 * boundary, and alchemy decodes the subscription's `ReadableStream` into an Effect `Stream`.
 */
export type ChatSessionRpc = Omit<EffectSurface<ChatSessionStub, unknown>, "subscribe"> & {
	readonly subscribe: (
		cursor: number,
	) => Effect.Effect<ReadableStream<Uint8Array> | Stream.Stream<Uint8Array, unknown>, unknown>
	readonly alarm: () => Effect.Effect<void>
}

export class ChatSessionCallError extends Schema.TaggedError<ChatSessionCallError>()(
	"@maple/domain/chat/ChatSessionCallError",
	{
		method: Schema.String,
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** A session as a caller holds it: every method an Effect that fails with `ChatSessionCallError`. */
export type ChatSessionClient = EffectSurface<ChatSessionStub, ChatSessionCallError>

const callFailed = (method: string) => (cause: unknown) =>
	new ChatSessionCallError({ method, message: `ChatSession.${method} failed`, cause })

/** `subscribe`'s value as a byte stream, whichever form it crossed the RPC boundary in. */
const subscription = (body: ReadableStream<Uint8Array> | Stream.Stream<Uint8Array, unknown>) =>
	body instanceof ReadableStream
		? body
		: Stream.toReadableStream(Stream.mapError(body, callFailed("subscribe")))

/**
 * A client over one of alchemy's RPC stubs: a call that failed across the RPC boundary is kept as
 * a `ChatSessionCallError`.
 */
export const chatSessionClient = (rpc: ChatSessionRpc): ChatSessionClient => ({
	cursor: () => rpc.cursor().pipe(Effect.mapError(callFailed("cursor"))),
	running: () => rpc.running().pipe(Effect.mapError(callFailed("running"))),
	history: () => rpc.history().pipe(Effect.mapError(callFailed("history"))),
	since: (cursor) => rpc.since(cursor).pipe(Effect.mapError(callFailed("since"))),
	subscribe: (cursor) =>
		rpc.subscribe(cursor).pipe(Effect.mapError(callFailed("subscribe")), Effect.map(subscription)),
	append: (event) => rpc.append(event).pipe(Effect.mapError(callFailed("append"))),
	beginTurn: (input) => rpc.beginTurn(input).pipe(Effect.mapError(callFailed("beginTurn"))),
	settleProposal: (input) => rpc.settleProposal(input).pipe(Effect.mapError(callFailed("settleProposal"))),
	holdsTurn: (messageId) => rpc.holdsTurn(messageId).pipe(Effect.mapError(callFailed("holdsTurn"))),
	endTurn: (messageId) => rpc.endTurn(messageId).pipe(Effect.mapError(callFailed("endTurn"))),
	abort: () => rpc.abort().pipe(Effect.mapError(callFailed("abort"))),
})

/** A client over a Promise-shaped stub: an in-process session, or a test's fake. */
export const chatSessionClientFromStub = (stub: ChatSessionStub): ChatSessionClient => {
	const call =
		<Args extends ReadonlyArray<unknown>, A>(method: string, run: (...args: Args) => Promise<A>) =>
		(...args: Args) =>
			Effect.tryPromise({ try: () => run(...args), catch: callFailed(method) })
	return {
		cursor: call("cursor", () => stub.cursor()),
		running: call("running", () => stub.running()),
		history: call("history", () => stub.history()),
		since: call("since", (cursor: number) => stub.since(cursor)),
		subscribe: call("subscribe", (cursor: number) => stub.subscribe(cursor)),
		append: call("append", (event: Parameters<ChatSessionStub["append"]>[0]) => stub.append(event)),
		beginTurn: call("beginTurn", (input: Parameters<ChatSessionStub["beginTurn"]>[0]) =>
			stub.beginTurn(input),
		),
		settleProposal: call("settleProposal", (input: ChatProposalSettlement) => stub.settleProposal(input)),
		holdsTurn: call("holdsTurn", (messageId: string) => stub.holdsTurn(messageId)),
		endTurn: call("endTurn", (messageId: string) => stub.endTurn(messageId)),
		abort: call("abort", () => stub.abort()),
	}
}
