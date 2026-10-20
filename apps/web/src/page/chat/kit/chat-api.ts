import {
	ChatHistoryResponse,
	type ChatEvent,
	ChatSendResponse,
	decodeChatEvent,
} from "@maple/domain/chat-session"
import { apiBaseUrl } from "../../../lib/services/common/api-base-url"
import { Clock, Effect, Option, Ref, Schema, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { MapleSyncHttpClient } from "../../../platform/api-clients"
import { taskOf } from "./fold"

// The chat transport: Maple's durable chat session at
// `/api/chat/sessions/<orgId>:<tabId>`. Raw routes, so plain requests with the session bearer.

export class ChatRequestError extends Schema.TaggedError<ChatRequestError>()("@maple/web/chat/ChatRequestError", {
	message: Schema.String,
}) {}

/** A send the server refused because the conversation already has a turn in flight. */
export const TURN_IN_FLIGHT_MESSAGE =
	"This conversation already has a reply in progress. Wait for it to finish, or stop it first."

const sessionUrl = (sessionId: string, suffix: string): string =>
	`${apiBaseUrl}/api/chat/sessions/${encodeURIComponent(sessionId)}${suffix}`

/** A browser `TypeError` and friends surface as their own `message` text. */
const failWith =
	(message: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ChatRequestError, R> =>
		Effect.mapError(effect, (error) =>
			error instanceof ChatRequestError ? error : new ChatRequestError({ message }),
		)

/** `GET .../history`: the durable transcript, its resume cursor, and whether a turn is running. */
export const loadHistory = (sessionId: string) =>
	Effect.gen(function* () {
		const client = yield* MapleSyncHttpClient
		const response = yield* client.get(sessionUrl(sessionId, "/history"))
		if (response.status < 200 || response.status >= 300)
			return yield* new ChatRequestError({ message: `Failed to load chat history: ${response.status}` })
		return yield* HttpClientResponse.schemaBodyJson(ChatHistoryResponse)(response)
	}).pipe(failWith("Failed to load chat history."))

/** `POST .../messages` with the (preamble-wrapped) text; `409` is a turn already in flight. */
export const postMessage = (sessionId: string, text: string) =>
	Effect.gen(function* () {
		const client = yield* MapleSyncHttpClient
		const request = HttpClientRequest.post(sessionUrl(sessionId, "/messages")).pipe(
			HttpClientRequest.bodyJsonUnsafe({ text }),
		)
		const response = yield* client.execute(request)
		if (response.status === 409) return yield* new ChatRequestError({ message: TURN_IN_FLIGHT_MESSAGE })
		if (response.status < 200 || response.status >= 300)
			return yield* new ChatRequestError({ message: `Failed to send message: ${response.status}` })
		return yield* HttpClientResponse.schemaBodyJson(ChatSendResponse)(response)
	}).pipe(failWith("Failed to send message."))

/** `POST .../abort`: best effort, the turn settles on its own if it never lands. */
export const abortTurn = (sessionId: string) =>
	Effect.gen(function* () {
		const client = yield* MapleSyncHttpClient
		yield* client.execute(HttpClientRequest.post(sessionUrl(sessionId, "/abort")))
	}).pipe(Effect.ignore)

// THE LIVE TAIL

/** Consecutive-failure budget for a dropped events stream before it surfaces an error. */
const MAX_STREAM_RETRIES = 3
/** An empty close sooner than this is the server refusing; a later one is an idle connection recycled. */
const QUICK_CLOSE_MS = 5_000

/** One SSE frame's `data:` lines joined (a payload may span several), or `None`. */
const frameData = (frame: string): Option.Option<string> => {
	const data = frame
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n")
	return data === "" ? Option.none() : Option.some(data)
}

/** What the tail reports: a batch of events (one network read), the turn's end, or a failure. */
export type TailOutput =
	| { readonly _tag: "Events"; readonly events: ReadonlyArray<ChatEvent> }
	| { readonly _tag: "Failed"; readonly message: string }

const isTopLevelTurnEnd = (event: ChatEvent): boolean => event.type === "turn-end" && taskOf(event) === undefined

/**
 * `GET .../events?cursor=`, read as SSE frames until the top-level `turn-end`. A clean EOF without
 * one is the server recycling the connection: it reconnects from the last seq, at once if it
 * delivered events. A dropped or empty connection retries with a 300 ms × n backoff,
 * `MAX_STREAM_RETRIES` times in a row.
 */
export const tailEvents = (sessionId: string, cursor: number): Stream.Stream<TailOutput, never, MapleSyncHttpClient> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const seq = yield* Ref.make(cursor)
			const ended = yield* Ref.make(false)
			const retry = (failures: number, message: string): Stream.Stream<TailOutput, never, MapleSyncHttpClient> =>
				failures + 1 > MAX_STREAM_RETRIES
					? Stream.succeed<TailOutput>({ _tag: "Failed", message })
					: Stream.unwrap(Effect.as(Effect.sleep(300 * (failures + 1)), connection(failures + 1)))
			const connection = (failures: number): Stream.Stream<TailOutput, never, MapleSyncHttpClient> =>
				Stream.unwrap(
					// When the response arrived; a close before it counts as quick.
					Effect.map(Effect.all([Ref.get(seq), Ref.make(Number.POSITIVE_INFINITY)]), ([from, openedAt]) =>
						attempt(from, failures, openedAt),
					),
				)
			const attempt = (
				from: number,
				failures: number,
				openedAt: Ref.Ref<number>,
			): Stream.Stream<TailOutput, never, MapleSyncHttpClient> =>
				Stream.unwrap(
					Effect.gen(function* () {
						const client = yield* MapleSyncHttpClient
						const response = yield* client.get(sessionUrl(sessionId, `/events?cursor=${from}`))
						if (response.status < 200 || response.status >= 300)
							return yield* new ChatRequestError({
								message: `Chat stream request failed: ${response.status}`,
							})
						yield* Ref.set(openedAt, yield* Clock.currentTimeMillis)
						return response.stream.pipe(
							Stream.decodeText(),
							Stream.mapAccum(
								() => "",
								(buffer, chunk) => {
									const frames = (buffer + chunk).split("\n\n")
									const rest = frames.pop() ?? ""
									return [rest, [frames]] as const
								},
							),
							Stream.map((frames) =>
								frames.flatMap((frame) =>
									Option.toArray(Option.flatMap(frameData(frame), (data) => Option.fromNullishOr(decodeChatEvent(data)))),
								),
							),
							Stream.filter((events) => events.length > 0),
							Stream.mapEffect((events) => {
								const endIndex = events.findIndex(isTopLevelTurnEnd)
								const kept = endIndex === -1 ? events : events.slice(0, endIndex + 1)
								const last = kept[kept.length - 1]
								return Effect.as(
									Effect.andThen(
										last === undefined ? Effect.void : Ref.set(seq, last.seq),
										endIndex === -1 ? Effect.void : Ref.set(ended, true),
									),
									kept,
								)
							}),
							Stream.takeUntil(isEndBatch),
							Stream.map((events): TailOutput => ({ _tag: "Events", events })),
						)
					}),
				).pipe(
					// A quick clean close that delivered nothing counts as a failure, so it cannot hot-loop.
					Stream.concat(
						Stream.unwrap(
							Effect.gen(function* () {
								if (yield* Ref.get(ended)) return Stream.empty
								const delivered = (yield* Ref.get(seq)) !== from
								const lived = (yield* Clock.currentTimeMillis) - (yield* Ref.get(openedAt))
								return delivered || lived >= QUICK_CLOSE_MS
									? connection(0)
									: retry(failures, "Lost connection to chat.")
							}),
						),
					),
					Stream.catch((error) =>
						retry(failures, error instanceof ChatRequestError ? error.message : "Lost connection to chat."),
					),
				)
			return connection(0)
		}),
	)

const isEndBatch = (events: ReadonlyArray<ChatEvent>): boolean => events.some(isTopLevelTurnEnd)
