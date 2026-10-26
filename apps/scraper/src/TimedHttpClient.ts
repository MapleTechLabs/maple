import * as http from "node:http"
import * as https from "node:https"
import { Readable } from "node:stream"
import { Effect, type Layer, Predicate } from "effect"
import { HttpClient, HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { DialServerName } from "@maple/safe-fetch"
import { recordPhases } from "./UptimePhases"

/** Statuses a web `Response` must be built without a body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304])

const transportError = (request: HttpClientRequest.HttpClientRequest, cause: unknown, description?: string) =>
	new HttpClientError.HttpClientError({
		reason: new HttpClientError.TransportError({ request, cause, description }),
	})

/** The probe only sends text or no body; anything else is refused rather than half-sent. */
const bodyOf = (
	request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<Uint8Array | string | undefined, HttpClientError.HttpClientError> => {
	const { body } = request
	switch (body._tag) {
		case "Empty":
			return Effect.succeed(undefined)
		case "Uint8Array":
			return Effect.succeed(body.body)
		case "Raw":
			return Predicate.isString(body.body) || body.body instanceof Uint8Array
				? Effect.succeed(body.body)
				: Effect.fail(transportError(request, undefined, "unsupported request body"))
		default:
			return Effect.fail(transportError(request, undefined, `unsupported ${body._tag} request body`))
	}
}

const webHeaders = (source: http.IncomingHttpHeaders): Headers =>
	new Headers(
		Object.entries(source).flatMap(([name, value]): Array<[string, string]> =>
			value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v) => [name, v]),
		),
	)

interface HopPhases {
	readonly connectMs?: number
	readonly tlsMs?: number
	readonly ttfbMs?: number
}

interface Answer {
	readonly response: http.IncomingMessage
	readonly phases: HopPhases
}

/** One request on a fresh connection, timing connect, TLS and the wait for the headers off its socket. */
const exchange = (
	request: HttpClientRequest.HttpClientRequest,
	url: URL,
	signal: AbortSignal,
	body: Uint8Array | string | undefined,
	serverName: string | null,
) =>
	Effect.callback<Answer, HttpClientError.HttpClientError>((resume) => {
		const startedAt = performance.now()
		// Socket events land in callbacks, so their times are kept here until the headers arrive.
		const marks = new Map<"connect" | "tls", number>()
		const options: https.RequestOptions = {
			method: request.method,
			headers: request.headers,
			// No pooling: every check measures, and dials, a connection of its own.
			agent: false,
			signal,
			...(serverName === null ? undefined : { servername: serverName }),
		}
		const outgoing = url.protocol === "https:" ? https.request(url, options) : http.request(url, options)
		outgoing.once("socket", (socket) => {
			socket.once("connect", () => marks.set("connect", performance.now()))
			socket.once("secureConnect", () => marks.set("tls", performance.now()))
		})
		const connected = (): HopPhases => {
			const connectAt = marks.get("connect")
			const tlsAt = marks.get("tls")
			return {
				...(connectAt === undefined ? undefined : { connectMs: connectAt - startedAt }),
				...(connectAt === undefined || tlsAt === undefined
					? undefined
					: { tlsMs: tlsAt - connectAt }),
			}
		}
		// Kept for the request's life: an abort after the headers still emits here. A failed hop
		// still reports what it got through (a connect before a refused handshake).
		outgoing.on("error", (cause) =>
			resume(Effect.andThen(recordPhases(connected()), Effect.fail(transportError(request, cause)))),
		)
		outgoing.once("response", (response) => {
			const ready = marks.get("tls") ?? marks.get("connect") ?? startedAt
			resume(
				Effect.succeed({ response, phases: { ...connected(), ttfbMs: performance.now() - ready } }),
			)
		})
		outgoing.end(body)
		return Effect.sync(() => outgoing.destroy())
	})

const toWeb = (request: HttpClientRequest.HttpClientRequest, response: http.IncomingMessage) =>
	Effect.try({
		try: () => {
			const status = response.statusCode ?? 0
			const bodyless = request.method === "HEAD" || NULL_BODY_STATUSES.has(status)
			// A body-less answer is drained; a late socket error on it has nobody to tell.
			if (bodyless) response.on("error", () => undefined).resume()
			return HttpClientResponse.fromWeb(
				request,
				new Response(bodyless ? null : Readable.toWeb(response), {
					status,
					statusText: response.statusMessage,
					headers: webHeaders(response.headers),
				}),
			)
		},
		catch: (cause) => transportError(request, cause),
	})

/**
 * An `HttpClient` over node:http and node:https that reports each request's connect, TLS and
 * time-to-headers to the current `PhaseRecorder`. Bun fires the socket events these come from;
 * its fetch does not expose them. A guarded hop's pinned TLS name comes from `DialServerName`.
 */
export const timedHttpClient: HttpClient.HttpClient = HttpClient.make((request, url, signal, fiber) =>
	Effect.gen(function* () {
		const body = yield* bodyOf(request)
		const { response, phases } = yield* exchange(request, url, signal, body, fiber.getRef(DialServerName))
		yield* recordPhases(phases)
		return yield* toWeb(request, response)
	}),
)

export const layer: Layer.Layer<HttpClient.HttpClient> = HttpClient.layerMergedContext(
	Effect.succeed(timedHttpClient),
)
