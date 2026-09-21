/**
 * One turn's events, read off the chat session as a stream.
 *
 * The session hands back pre-framed SSE bytes and closes the connection on the turn's end OR after
 * its own idle window — and a turn that spends a minute on a tool is silent for longer than that
 * window. So the end of a connection is not the end of the turn: this reconnects from the last
 * `seq` it saw and keeps going. What stops it is the driver, which takes events until the turn it
 * is rendering ends; replayed events it has already folded are identified by `seq` and change
 * nothing.
 */
import { ChatSessionId, decodeChatEvent, type ChatEvent } from "@maple/domain/chat-session"
import type { ChatSessionStub } from "@maple/domain/chat-session-stub"
import { Duration, Effect, Schema, Stream } from "effect"

/** The session's Durable Object could not be reached, or dropped the subscription mid-turn. */
export class ChatSessionUnreachable extends Schema.TaggedError<ChatSessionUnreachable>()(
	"@maple/chat-bot/ChatSessionUnreachable",
	{
		sessionId: ChatSessionId,
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** SSE frames are separated by a blank line, and a `data:` payload may span several lines. */
const FRAME_SEPARATOR = "\n\n"
const DATA_PREFIX = "data:"

/**
 * The event one frame carried, or nothing.
 *
 * Both skips are deliberate: the session opens every connection with a `retry:` hint that carries
 * no data at all, and a `ChatEvent` this build does not recognise is a newer session's event —
 * dropped here rather than thrown on, so a deploy skew degrades a turn instead of ending it.
 */
const eventOfFrame = (frame: string): ReadonlyArray<ChatEvent> => {
	const data = frame
		.split("\n")
		.filter((line) => line.startsWith(DATA_PREFIX))
		.map((line) => line.slice(DATA_PREFIX.length).trimStart())
		.join("\n")
	if (data === "") return []
	const event = decodeChatEvent(data)
	return event === undefined ? [] : [event]
}

export const sessionUnreachable = (sessionId: ChatSessionId, message: string) => (cause: unknown) =>
	new ChatSessionUnreachable({ sessionId, message, cause })

/** One connection's worth of events, from `cursor`. */
const connection = (
	stub: ChatSessionStub,
	sessionId: ChatSessionId,
	cursor: number,
): Stream.Stream<ChatEvent, ChatSessionUnreachable> =>
	Stream.unwrap(
		Effect.tryPromise({
			try: () => stub.subscribe(cursor),
			catch: sessionUnreachable(sessionId, "The chat session did not accept a subscription"),
		}).pipe(
			Effect.map((body) =>
				Stream.fromReadableStream({
					evaluate: () => body,
					onError: sessionUnreachable(sessionId, "The chat session's event stream failed"),
				}).pipe(
					Stream.decodeText(),
					// The buffer is the tail of a frame that spanned two chunks; whole frames go on.
					Stream.mapAccumArray(
						() => "",
						(buffer: string, chunks) => {
							const frames = (buffer + chunks.join("")).split(FRAME_SEPARATOR)
							return [frames.pop() ?? "", frames.flatMap(eventOfFrame)]
						},
					),
				),
			),
		),
	)

/**
 * How long to wait before reopening a connection that carried nothing.
 *
 * The session ends a connection after its idle window, which is seconds of silence, and reopening
 * that one immediately is right. A connection that closes having said nothing at all is a session
 * with nothing to say yet, and reopening THAT immediately is a loop.
 */
const EMPTY_RECONNECT_DELAY = Duration.seconds(1)

/** Every event from `cursor` on, across as many connections as the turn takes. */
export const chatTurnEvents = (
	stub: ChatSessionStub,
	sessionId: ChatSessionId,
	cursor: number,
): Stream.Stream<ChatEvent, ChatSessionUnreachable> => {
	const fromCursor = (from: number): Stream.Stream<ChatEvent, ChatSessionUnreachable> => {
		let last = from
		return connection(stub, sessionId, from).pipe(
			Stream.tap((event) =>
				Effect.sync(() => {
					last = event.seq
				}),
			),
			Stream.concat(
				Stream.suspend(() =>
					Stream.unwrap(
						Effect.as(
							last === from ? Effect.sleep(EMPTY_RECONNECT_DELAY) : Effect.void,
							fromCursor(last),
						),
					),
				),
			),
		)
	}
	return fromCursor(cursor)
}
