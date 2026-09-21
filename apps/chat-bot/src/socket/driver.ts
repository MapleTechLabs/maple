/**
 * What the host does with one step of a connector's protocol.
 *
 * This is the whole of the socket loop that is worth testing, and it is
 * deliberately not inside the Durable Object: the object is a socket, a timer
 * and some storage, and everything it decides is here, where a fake connector
 * and a fake socket can drive it.
 *
 * It understands no protocol. It writes the frames it is handed, issues the
 * requests it is handed, hands the events on, and remembers the state — and it
 * would do exactly the same for a connector for any other platform.
 */
import type { ChatConnectorId, ConnectorRequest, SocketStep } from "@maple/chat-platform"
import { Duration, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { InboundHandler } from "../inbound.ts"

/** The live connection, as much of it as the loop needs. */
export interface SocketSink {
	readonly send: (frame: string) => void
}

/** Where the connector's opaque state lives between activations. */
export interface SocketStore {
	readonly write: (state: string) => Effect.Effect<void>
}

export interface SocketPorts {
	readonly connectorId: ChatConnectorId
	readonly sink: SocketSink
	readonly store: SocketStore
}

/**
 * How long one of the connector's requests may take before it is abandoned.
 *
 * These requests run BEFORE the state is persisted and the events published, so
 * an endpoint that accepts the connection and then stalls would hold up the
 * session write behind it. Two seconds is inside every acknowledgement deadline
 * a chat platform sets (the tightest known is three), and a request that has not
 * landed by then was not going to.
 */
const REQUEST_TIMEOUT = Duration.seconds(2)

/**
 * Issue one of the connector's requests.
 *
 * A failure is logged and dropped rather than propagated: these are
 * acknowledgements with a deadline attached, and a connection that is otherwise
 * healthy should not be torn down because one of them did not land.
 */
const issueRequest = Effect.fnUntraced(
	function* (connectorId: ChatConnectorId, request: ConnectorRequest) {
		const client = yield* HttpClient.HttpClient
		const contentType = request.headers.get("content-type") ?? "application/json"
		const built = HttpClientRequest.make(request.method)(request.url, {
			headers: Object.fromEntries(request.headers),
		}).pipe(HttpClientRequest.bodyText(request.body, contentType))
		const response = yield* client.execute(built)
		if (response.status >= 400) {
			yield* Effect.logWarning("Chat connector request was rejected").pipe(
				Effect.annotateLogs({
					"maple.chat.connector": connectorId,
					"http.response.status_code": response.status,
				}),
			)
		}
	},
	(effect, connectorId) => {
		/**
		 * The REASON, never the error. An `HttpClientError` serializes the request
		 * it failed on — URL and body included — and a connector's request URL is
		 * allowed to carry a credential (the one this connector acknowledges
		 * interactions with does) while its body is exactly where a future
		 * connector would put conversation content. The tag is what tells a rate
		 * limit from a DNS failure, and it is all of it that is safe to write down.
		 */
		const dropped = (errorType: string) =>
			Effect.logWarning("Chat connector request failed").pipe(
				Effect.annotateLogs({
					"maple.chat.connector": connectorId,
					"error.type": errorType,
				}),
			)
		return effect.pipe(
			Effect.catchTag("HttpClientError", (error) => dropped(error.reason._tag)),
			Effect.timeout(REQUEST_TIMEOUT),
			Effect.catchTag("TimeoutError", () => dropped("TimeoutError")),
		)
	},
)

/**
 * Write, acknowledge, persist, publish — in that order, and the order is the
 * argument.
 *
 * Frames go first because a heartbeat that is late is a connection that is about
 * to be declared dead, and the acknowledgements a platform puts a deadline on go
 * with them. The state is durable before any event leaves the object, so a
 * failure while publishing costs a duplicate event rather than a lost session.
 *
 * Sequential throughout, deliberately: frames on one socket have an order, and
 * the acknowledgements are one per event, so concurrency here would buy nothing
 * and lose the ordering the comment above is about.
 *
 * `fnUntraced`, not `fn`: this runs on every heartbeat, and a span per heartbeat
 * is ingest volume spent observing a timer. The span that matters is the one
 * `InboundHandler` opens per event.
 */
export const applyStep = Effect.fnUntraced(function* (
	ports: SocketPorts,
	step: SocketStep<string>,
) {
	yield* Effect.forEach(step.send ?? [], (frame) => Effect.sync(() => ports.sink.send(frame)), {
		discard: true,
	})
	yield* Effect.forEach(
		step.requests ?? [],
		(request) => issueRequest(ports.connectorId, request),
		{ discard: true },
	)
	yield* ports.store.write(step.state)
	const events = step.events ?? []
	if (events.length === 0) return
	const inbound = yield* InboundHandler
	yield* Effect.forEach(events, (event) => inbound.handle(event), { discard: true })
})

/** First retry after a second, doubling to a minute. */
export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 60_000

/**
 * How long to wait before the next connection attempt.
 *
 * Exponential, because the two things that keep a connection from coming up —
 * a platform outage and a rate limit — both get worse if every client retries
 * at a fixed interval.
 */
export const reconnectDelayMs = (attempt: number): number =>
	Math.min(RECONNECT_BASE_MS * 2 ** Math.max(attempt, 0), RECONNECT_MAX_MS)
