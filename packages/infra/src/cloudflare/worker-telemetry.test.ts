import { assert, describe, it } from "@effect/vitest"
import { WorkerEnvironment } from "@alchemy.run/cloudflare"
import { afterEach } from "vitest"
import { Effect, Exit, Fiber, Layer, Scope, Tracer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { eventTelemetry, flushOnCadence, MapleHttpTracingLive } from "./worker-telemetry.ts"

describe("MapleHttpTracingLive", () => {
	it.effect("records the allowlisted headers and never a credential", () =>
		Effect.gen(function* () {
			const spans: Array<Tracer.NativeSpan> = []
			const tracer = Tracer.make({
				span(options) {
					const span = new Tracer.NativeSpan(options)
					spans.push(span)
					return span
				},
			})
			const client = yield* HttpClient.HttpClient
			yield* client
				.execute(
					HttpClientRequest.post("https://ch.example.test/").pipe(
						HttpClientRequest.setHeaders({
							"Content-Type": "text/plain",
							"X-ClickHouse-Key": "secret",
							Authorization: "Bearer secret",
						}),
					),
				)
				.pipe(Effect.withTracer(tracer))
			const attributes = spans[0]?.attributes
			assert.strictEqual(attributes?.get("http.request.header.content-type"), "text/plain")
			assert.strictEqual(attributes?.get("http.response.header.x-ratelimit-remaining"), "9")
			assert.isFalse(attributes?.has("http.request.header.x-clickhouse-key"))
			assert.isFalse(attributes?.has("http.request.header.authorization"))
			assert.isFalse(attributes?.has("http.response.header.set-cookie"))
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					FetchHttpClient.layer.pipe(
						Layer.provide(
							Layer.succeed(
								FetchHttpClient.Fetch,
								async () =>
									new Response("ok", {
										headers: {
											"x-ratelimit-remaining": "9",
											"set-cookie": "session=secret",
										},
									}),
							),
						),
					),
					MapleHttpTracingLive,
				),
			),
		),
	)
})

describe("eventTelemetry", () => {
	const original = globalThis.fetch
	afterEach(() => {
		globalThis.fetch = original
	})

	it.live("with a cadence, exports spans while the event is still running", () =>
		Effect.gen(function* () {
			const exported: Array<string> = []
			globalThis.fetch = (async (input: RequestInfo | URL) => {
				exported.push(String(input))
				return new Response(null, { status: 200 })
			}) as typeof fetch
			const env = { MAPLE_ENDPOINT: "https://collector.test", MAPLE_INGEST_KEY: "secret" }
			const scope = yield* Scope.make()
			const services = yield* Layer.buildWithScope(
				eventTelemetry({ serviceName: "unit-test", flushEvery: "20 millis" }).pipe(
					Layer.provide(Layer.succeed(WorkerEnvironment, env)),
				),
				scope,
			)
			// Two agents finishing apart: each export goes out on the cadence, not at the end.
			yield* Effect.void.pipe(Effect.withSpan("agent-1"), Effect.provide(services))
			yield* Effect.sleep("100 millis")
			yield* Effect.void.pipe(Effect.withSpan("agent-2"), Effect.provide(services))
			yield* Effect.sleep("100 millis")
			const whileRunning = exported.filter((url) => url.endsWith("/v1/traces")).length
			yield* Scope.close(scope, Exit.void)
			assert.isAtLeast(whileRunning, 2)
		}),
	)
})

describe("flushOnCadence", () => {
	it.live("keeps exporting after an export fails", () =>
		Effect.gen(function* () {
			const attempts: Array<number> = []
			const flush = () => {
				attempts.push(attempts.length)
				return attempts.length === 1 ? Promise.reject(new Error("collector down")) : Promise.resolve()
			}
			const fiber = yield* Effect.forkChild(flushOnCadence(flush, "10 millis"))
			yield* Effect.sleep("80 millis")
			yield* Fiber.interrupt(fiber)
			assert.isAtLeast(attempts.length, 3)
		}),
	)
})
