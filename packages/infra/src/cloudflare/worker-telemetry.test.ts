import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Tracer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { MapleHttpTracingLive } from "./worker-telemetry.ts"

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
