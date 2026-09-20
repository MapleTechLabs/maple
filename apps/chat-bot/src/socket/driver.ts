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
import { Effect } from "effect"
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
 * Issue one of the connector's requests.
 *
 * A failure is logged and dropped rather than propagated: these are
 * acknowledgements with a deadline attached, and a connection that is otherwise
 * healthy should not be torn down because one of them did not land.
 */
const issueRequest = (connectorId: ChatConnectorId, request: ConnectorRequest) =>
	Effect.gen(function* () {
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
	}).pipe(
		Effect.catchTag("HttpClientError", (error) =>
			Effect.logWarning("Chat connector request failed", error).pipe(
				Effect.annotateLogs({ "maple.chat.connector": connectorId }),
			),
		),
	)

/**
 * Write, acknowledge, persist, publish — in that order, and the order is the
 * argument.
 *
 * Frames go first because a heartbeat that is late is a connection that is about
 * to be declared dead, and the acknowledgements a platform puts a deadline on go
 * with them. The state is durable before any event leaves the object, so a
 * failure while publishing costs a duplicate event rather than a lost session.
 */
export const applyStep = (
	ports: SocketPorts,
	step: SocketStep<string>,
): Effect.Effect<void, never, HttpClient.HttpClient | InboundHandler> =>
	Effect.gen(function* () {
		for (const frame of step.send ?? []) {
			yield* Effect.sync(() => ports.sink.send(frame))
		}
		for (const request of step.requests ?? []) {
			yield* issueRequest(ports.connectorId, request)
		}
		yield* ports.store.write(step.state)
		if ((step.events ?? []).length === 0) return
		const inbound = yield* InboundHandler
		for (const event of step.events ?? []) {
			yield* inbound.handle(event)
		}
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
