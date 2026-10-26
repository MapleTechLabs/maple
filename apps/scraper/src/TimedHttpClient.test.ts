import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Ref, Result } from "effect"
import { HttpClientRequest } from "effect/http"
import { readTextPrefix } from "@maple/safe-fetch"
import { timedHttpClient } from "./TimedHttpClient"
import { describeTransportFailure, errorCodeOf } from "./UptimeProbe"
import { addPhases, NO_PHASES, PhaseRecorder, type PhaseTimings } from "./UptimePhases"

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void

/** A loopback HTTP server for the scope, on an ephemeral port. */
const serve = (handler: Handler) =>
	Effect.acquireRelease(
		Effect.callback<Server>((resume) => {
			const server = createServer((request, response) => {
				const chunks: Array<Buffer> = []
				request.on("data", (chunk: Buffer) => chunks.push(chunk))
				request.on("end", () => handler(request, Buffer.concat(chunks).toString(), response))
			})
			server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
		}),
		(server) =>
			Effect.callback<void>((resume) => {
				server.closeAllConnections()
				server.close(() => resume(Effect.void))
			}),
	)

const urlOf = (server: Server, path = "/"): string => {
	const address = server.address()
	return `http://127.0.0.1:${address !== null && typeof address === "object" ? address.port : 0}${path}`
}

/** Runs `use` with a recorder, returning what it produced and the phases it reported. */
const recording = <A, E, R>(use: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const phases = yield* Ref.make<PhaseTimings>(NO_PHASES)
		const value = yield* use.pipe(
			Effect.provideService(PhaseRecorder, (hop) =>
				Ref.update(phases, (total) => addPhases(total, hop)),
			),
		)
		return { value, phases: yield* Ref.get(phases) }
	})

describe("timedHttpClient", () => {
	it.live("times connect and the wait for the headers, and has no TLS phase on http://", () =>
		Effect.gen(function* () {
			const server = yield* serve((_, __, response) => {
				setTimeout(() => response.writeHead(200, { "x-region": "fra" }).end("ok"), 40)
			})
			const { value, phases } = yield* recording(
				timedHttpClient.get(urlOf(server, "/health")).pipe(
					Effect.flatMap((response) =>
						Effect.map(response.text, (text) => ({
							status: response.status,
							region: response.headers["x-region"],
							text,
						})),
					),
					Effect.scoped,
				),
			)
			assert.deepStrictEqual(value, { status: 200, region: "fra", text: "ok" })
			assert.isAtLeast(phases.connectMs ?? -1, 0)
			assert.isAtLeast(phases.ttfbMs ?? 0, 30)
			assert.deepStrictEqual([phases.tlsMs, phases.dnsMs], [null, null])
		}),
	)

	it.live("sends the body with a length and reads a chunked answer to its end", () =>
		Effect.gen(function* () {
			const server = yield* serve((request, body, response) => {
				response.writeHead(200)
				response.write(`${request.method} ${request.headers["content-length"]} `)
				response.end(body)
			})
			const text = yield* timedHttpClient
				.execute(
					HttpClientRequest.post(urlOf(server)).pipe(HttpClientRequest.bodyText('{"ping":true}')),
				)
				.pipe(
					Effect.flatMap((response) => response.text),
					Effect.scoped,
				)
			assert.strictEqual(text, 'POST 13 {"ping":true}')
		}),
	)

	it.live("answers a HEAD and a 204 without a body", () =>
		Effect.gen(function* () {
			const server = yield* serve((_, __, response) => response.writeHead(204).end())
			const statuses = yield* Effect.forEach(["HEAD", "GET"] as const, (method) =>
				timedHttpClient.execute(HttpClientRequest.make(method)(urlOf(server))).pipe(
					Effect.flatMap((response) => Effect.as(response.text, response.status)),
					Effect.scoped,
				),
			)
			assert.deepStrictEqual(statuses, [204, 204])
		}),
	)

	it.live("stops reading a large body at the budget", () =>
		Effect.gen(function* () {
			const server = yield* serve((_, __, response) => response.writeHead(200).end("x".repeat(200_000)))
			const prefix = yield* timedHttpClient.get(urlOf(server)).pipe(
				Effect.flatMap((response) => readTextPrefix(response, 1024)),
				Effect.scoped,
			)
			assert.deepStrictEqual([prefix.text.length, prefix.truncated], [1024, true])
		}),
	)

	it.live("a refused connection keeps the system error code the probe's sentences key on", () =>
		Effect.gen(function* () {
			const port = yield* serve(() => undefined).pipe(
				Effect.map((server) => urlOf(server)),
				Effect.scoped,
			)
			const result = yield* timedHttpClient.get(port).pipe(Effect.scoped, Effect.result)
			assert.isTrue(Result.isFailure(result))
			if (Result.isFailure(result)) {
				const failure = describeTransportFailure(
					"127.0.0.1:1",
					errorCodeOf(result.failure.reason.cause),
					"unknown",
				)
				assert.strictEqual(failure.errorType, "connection_refused")
			}
		}),
	)

	it.live("an interrupted request closes its connection", () =>
		Effect.gen(function* () {
			const closed = yield* Deferred.make<void>()
			const server = yield* serve((request) => {
				request.socket.on("close", () => Deferred.doneUnsafe(closed, Effect.void))
			})
			const result = yield* timedHttpClient
				.get(urlOf(server))
				.pipe(Effect.scoped, Effect.timeout(Duration.millis(50)), Effect.result)
			assert.isTrue(Result.isFailure(result))
			// The server sees the socket close; a leaked connection would hit this timeout instead.
			yield* Deferred.await(closed).pipe(Effect.timeout(Duration.seconds(2)))
		}),
	)
})
