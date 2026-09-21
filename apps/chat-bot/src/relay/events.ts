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
import { decodeChatEvent, type ChatEvent } from "@maple/domain/chat-session"
import type { ChatSessionStub } from "@maple/domain/chat-session-stub"
import { Effect, Schema, Stream } from "effect"

/** The session's Durable Object could not be reached, or dropped the subscription mid-turn. */
export class ChatSessionUnreachable extends Schema.TaggedError<ChatSessionUnreachable>()(
	"@maple/chat-bot/ChatSessionUnreachable",
	{
		sessionId: Schema.String,
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

const unreachable = (sessionId: string, message: string) => (cause: unknown) =>
	new ChatSessionUnreachable({ sessionId, message, cause })

/** One connection's worth of events, from `cursor`. */
const connection = (
	stub: ChatSessionStub,
	sessionId: string,
	cursor: number,
): Stream.Stream<ChatEvent, ChatSessionUnreachable> =>
	Stream.unwrap(
		Effect.tryPromise({
			try: () => stub.subscribe(cursor),
			catch: unreachable(sessionId, "The chat session did not accept a subscription"),
		}).pipe(
			Effect.map((body) =>
				Stream.fromReadableStream({
					evaluate: () => body,
					onError: unreachable(sessionId, "The chat session's event stream failed"),
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

/** Every event from `cursor` on, across as many connections as the turn takes. */
export const chatTurnEvents = (
	stub: ChatSessionStub,
	sessionId: string,
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
			Stream.concat(Stream.suspend(() => fromCursor(last))),
		)
	}
	return fromCursor(cursor)
}
