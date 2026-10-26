import { gunzipSync } from "node:zlib"
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Exit, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { OtlpIngest } from "./OtlpIngest"
import { ScraperEnv, type ScraperEnvConfig } from "./Env"
import { endedSpansNamed, makeCapturingTracer } from "./testing/capturing-tracer"
import type { OtlpExportRequest } from "@maple/prometheus-otlp"

const testEnv: ScraperEnvConfig = {
	MAPLE_API_URL: "http://api.test",
	SD_INTERNAL_TOKEN: Redacted.make("internal-token"),
	MAPLE_INGEST_URL: "http://ingest.test",
	SCRAPER_CONCURRENCY: 10,
	SCRAPER_RECONCILE_INTERVAL_SECONDS: 60,
	SCRAPER_OTLP_MAX_DATA_POINTS: 10_000,
	SCRAPER_OTLP_MAX_BODY_BYTES: 4 * 1024 * 1024,
	UPTIME_CONCURRENCY: 20,
	PORT: 0,
}

const TestLayer = OtlpIngest.layer.pipe(
	Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(ScraperEnv, testEnv))),
)

/** Lets the stubbed fetch settle on the real event loop, then moves the test clock past a backoff. */
const settleAndAdvance = (steps: number, by: Duration.Input = "2 seconds") =>
	Effect.forEach(
		Array.from({ length: steps }),
		() =>
			Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).pipe(
				Effect.andThen(TestClock.adjust(by)),
			),
		{ discard: true },
	)

const SAMPLE_REQUEST: OtlpExportRequest = {
	resourceMetrics: [
		{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "node" } }] },
			scopeMetrics: [
				{
					scope: { name: "maple-prometheus-scraper" },
					metrics: [
						{
							name: "up",
							description: "",
							unit: "",
							gauge: {
								dataPoints: [
									{
										attributes: [],
										startTimeUnixNano: "0",
										timeUnixNano: "1750000000000000000",
										asDouble: 1,
									},
								],
							},
						},
					],
				},
			],
		},
	],
}

interface RecordedRequest {
	url: string
	method: string
	headers: Record<string, string>
	/** Decompressed. */
	body: string | null
	wireBytes: number
}

const stubFetch = (recorded: Array<RecordedRequest>, respond: () => Response): typeof globalThis.fetch =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {}
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value
		})
		recorded.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers,
			body:
				typeof init?.body === "string"
					? init.body
					: init?.body instanceof Uint8Array
						? new TextDecoder().decode(
								headers["content-encoding"] === "gzip" ? gunzipSync(init.body) : init.body,
							)
						: null,
			wireBytes: init?.body instanceof Uint8Array ? init.body.byteLength : 0,
		})
		return respond()
	}) as typeof globalThis.fetch

describe("OtlpIngest", () => {
	it.effect("posts OTLP JSON to the gateway with the org's ingest key", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const otlp = yield* OtlpIngest
			yield* otlp.send("maple_pk_test_key", SAMPLE_REQUEST).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => Response.json({ partialSuccess: {} })),
				),
			)

			assert.strictEqual(recorded[0]?.url, "http://ingest.test/v1/metrics")
			assert.strictEqual(recorded[0]?.method, "POST")
			assert.strictEqual(recorded[0]?.headers.authorization, "Bearer maple_pk_test_key")
			assert.strictEqual(recorded[0]?.headers["content-type"], "application/json")
			assert.strictEqual(recorded[0]?.headers["content-encoding"], "gzip")
			assert.deepStrictEqual(JSON.parse(recorded[0]?.body ?? "{}"), SAMPLE_REQUEST)
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("surfaces a billing-limit rejection (402) as a typed error", () =>
		Effect.gen(function* () {
			const otlp = yield* OtlpIngest
			const error = yield* otlp.send("maple_pk_test_key", SAMPLE_REQUEST).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch([], () => new Response("metrics limit reached", { status: 402 })),
				),
				Effect.flip,
			)
			assert.strictEqual(error.reason, "delivery_blocked")
			assert.strictEqual(error.statusCode, 402)
			assert.include(error.message, "billing limit")
		}).pipe(Effect.provide(TestLayer)),
	)

	// Any other rejection loses the export (bad key, oversized body), so it is a
	// real failure: it errors the span and holds cadence.
	it.effect("fails and errors its span on any other non-2xx response", () =>
		Effect.gen(function* () {
			const tracer = makeCapturingTracer()
			const otlp = yield* OtlpIngest
			const error = yield* otlp.send("maple_pk_test_key", SAMPLE_REQUEST).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch([], () => new Response("nope", { status: 401 })),
				),
				Effect.provide(tracer.layer),
				Effect.flip,
			)
			assert.strictEqual(error.reason, "scrape_failed")
			assert.strictEqual(error.statusCode, 401)
			const [span] = endedSpansNamed(tracer.ended, "OtlpIngest.send")
			assert.isTrue(Exit.isFailure(span!.exit))
			assert.strictEqual(span!.attributes.get("http.response.status_code"), 401)
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("retries a gateway 503 and delivers the export", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const otlp = yield* OtlpIngest
			const fiber = yield* Effect.forkChild(
				otlp.send("maple_pk_test_key", SAMPLE_REQUEST).pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						stubFetch(recorded, () =>
							recorded.length === 1
								? new Response("deploying", { status: 503 })
								: Response.json({ partialSuccess: {} }),
						),
					),
				),
			)
			yield* settleAndAdvance(2)
			yield* Fiber.join(fiber)
			assert.lengthOf(recorded, 2)
		}).pipe(Effect.provide(TestLayer)),
	)

	// A billing block is the expected, caller-side outcome for an org over its
	// limit: the typed error still reaches the caller, but the span stays Ok.
	it.effect("annotates rather than errors its span on a billing rejection (402)", () =>
		Effect.gen(function* () {
			const tracer = makeCapturingTracer()
			const otlp = yield* OtlpIngest
			yield* otlp.send("maple_pk_test_key", SAMPLE_REQUEST).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch([], () => new Response("metrics limit reached", { status: 402 })),
				),
				Effect.provide(tracer.layer),
				Effect.flip,
			)

			const spans = endedSpansNamed(tracer.ended, "OtlpIngest.send")
			assert.lengthOf(spans, 1)
			assert.isTrue(Exit.isSuccess(spans[0]!.exit))
			assert.strictEqual(spans[0]!.attributes.get("error.type"), "delivery_blocked")
			assert.strictEqual(spans[0]!.attributes.get("http.response.status_code"), 402)
		}).pipe(Effect.provide(TestLayer)),
	)

	// A gateway that accepts the connection but never answers must not pin the
	// scrape (and its global concurrency permit) forever — the send times out
	// as a retryable typed error.
	it.effect("times out a stalled gateway request as a typed error", () =>
		Effect.gen(function* () {
			const otlp = yield* OtlpIngest
			// Bun's `fetch` type carries `preconnect`; nothing under test calls it.
			const stalled: typeof globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), {
				preconnect: () => Promise.resolve(),
			})
			const fiber = yield* Effect.forkChild(
				otlp
					.send("maple_pk_test_key", SAMPLE_REQUEST)
					.pipe(Effect.provideService(FetchHttpClient.Fetch, stalled), Effect.flip),
				{ startImmediately: true },
			)
			// Each of the three attempts times out at 30s, with a backoff between them.
			yield* settleAndAdvance(3, "35 seconds")
			const error = yield* Fiber.join(fiber)
			assert.strictEqual(error.reason, "scrape_failed")
			assert.strictEqual(error.statusCode, null)
		}).pipe(Effect.provide(TestLayer)),
	)

	describe("chunked delivery", () => {
		/** Budget of 2 data points per POST, so a 5-point export needs 3 requests. */
		const ChunkedLayer = OtlpIngest.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					FetchHttpClient.layer,
					Layer.succeed(ScraperEnv, { ...testEnv, SCRAPER_OTLP_MAX_DATA_POINTS: 2 }),
				),
			),
		)

		const ByteCappedLayer = OtlpIngest.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					FetchHttpClient.layer,
					Layer.succeed(ScraperEnv, { ...testEnv, SCRAPER_OTLP_MAX_BODY_BYTES: 600 }),
				),
			),
		)

		const LARGE_REQUEST: OtlpExportRequest = {
			resourceMetrics: [
				{
					resource: { attributes: [{ key: "service.name", value: { stringValue: "scylla" } }] },
					scopeMetrics: [
						{
							scope: { name: "maple-prometheus-scraper" },
							metrics: [
								{
									name: "scylla_reactor_utilization",
									description: "",
									unit: "",
									gauge: {
										dataPoints: Array.from({ length: 5 }, (_, index) => ({
											attributes: [
												{ key: "shard", value: { stringValue: String(index) } },
											],
											startTimeUnixNano: "0",
											timeUnixNano: "1750000000000000000",
											asDouble: index,
										})),
									},
								},
							],
						},
					],
				},
			],
		}

		const pointsIn = (body: string | null) => {
			// Annotated rather than asserted: `JSON.parse` is `any`, and the body is
			// the request this test just handed to the client.
			const parsed: OtlpExportRequest = JSON.parse(body ?? '{"resourceMetrics":[]}')
			return parsed.resourceMetrics.flatMap((resourceMetrics) =>
				resourceMetrics.scopeMetrics.flatMap((scopeMetrics) =>
					scopeMetrics.metrics.flatMap((metric) => metric.gauge?.dataPoints ?? []),
				),
			)
		}

		// The 413 that took the customer's ScyllaDB board blind: the gateway
		// rejects an oversized body whole, so one export must become several
		// POSTs rather than one all-or-nothing request.
		it.effect("splits a large export across several POSTs without losing data points", () =>
			Effect.gen(function* () {
				const recorded: Array<RecordedRequest> = []
				const otlp = yield* OtlpIngest
				yield* otlp.send("maple_pk_test_key", LARGE_REQUEST).pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						stubFetch(recorded, () => Response.json({ partialSuccess: {} })),
					),
				)

				assert.lengthOf(recorded, 3)
				assert.deepStrictEqual(
					recorded.map((request) => pointsIn(request.body).length),
					[2, 2, 1],
				)
				assert.deepStrictEqual(
					recorded.flatMap((request) => pointsIn(request.body).map((point) => point.asDouble)),
					[0, 1, 2, 3, 4],
				)
				for (const request of recorded) {
					assert.strictEqual(request.headers.authorization, "Bearer maple_pk_test_key")
				}
			}).pipe(Effect.provide(ChunkedLayer)),
		)

		// A whole discovery cycle is one export: attribute-heavy points can blow past
		// the gateway limit well inside the point budget, so bytes cap chunks too.
		it.effect("also splits by uncompressed body size, under the point budget", () =>
			Effect.gen(function* () {
				const recorded: Array<RecordedRequest> = []
				const otlp = yield* OtlpIngest
				yield* otlp.send("maple_pk_test_key", LARGE_REQUEST).pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						stubFetch(recorded, () => Response.json({ partialSuccess: {} })),
					),
				)

				assert.isAbove(recorded.length, 1)
				for (const request of recorded) {
					assert.isAtMost(new TextEncoder().encode(request.body ?? "").byteLength, 600)
				}
				assert.deepStrictEqual(
					recorded.flatMap((request) => pointsIn(request.body).map((point) => point.asDouble)),
					[0, 1, 2, 3, 4],
				)
			}).pipe(Effect.provide(ByteCappedLayer)),
		)

		it.effect("stops at the first rejected chunk and keeps the earlier ones delivered", () =>
			Effect.gen(function* () {
				const recorded: Array<RecordedRequest> = []
				let call = 0
				const otlp = yield* OtlpIngest
				const error = yield* otlp.send("maple_pk_test_key", LARGE_REQUEST).pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						stubFetch(recorded, () => {
							call++
							return call === 2
								? new Response("metrics limit reached", { status: 402 })
								: Response.json({ partialSuccess: {} })
						}),
					),
					Effect.flip,
				)

				assert.strictEqual(error.statusCode, 402)
				// Chunk 3 is never attempted — the org is over its limit.
				assert.lengthOf(recorded, 2)
			}).pipe(Effect.provide(ChunkedLayer)),
		)

		it.effect("keeps the parent span Ok on a 402 and records how much was delivered", () =>
			Effect.gen(function* () {
				const tracer = makeCapturingTracer()
				let call = 0
				const otlp = yield* OtlpIngest
				yield* otlp.send("maple_pk_test_key", LARGE_REQUEST).pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						stubFetch([], () => {
							call++
							return call === 2
								? new Response("metrics limit reached", { status: 402 })
								: Response.json({ partialSuccess: {} })
						}),
					),
					Effect.provide(tracer.layer),
					Effect.flip,
				)

				const [span] = endedSpansNamed(tracer.ended, "OtlpIngest.send")
				assert.isTrue(Exit.isSuccess(span!.exit))
				assert.strictEqual(span!.attributes.get("error.type"), "delivery_blocked")
				assert.strictEqual(span!.attributes.get("maple.otlp.data_points"), 5)
				assert.strictEqual(span!.attributes.get("maple.otlp.chunk_count"), 3)
				assert.strictEqual(span!.attributes.get("maple.otlp.chunks_delivered"), 1)
				assert.lengthOf(endedSpansNamed(tracer.ended, "OtlpIngest.send_chunk"), 2)
			}).pipe(Effect.provide(ChunkedLayer)),
		)

		it.effect("sends one request and one chunk span when the export fits", () =>
			Effect.gen(function* () {
				const tracer = makeCapturingTracer()
				const recorded: Array<RecordedRequest> = []
				const otlp = yield* OtlpIngest
				yield* otlp.send("maple_pk_test_key", SAMPLE_REQUEST).pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						stubFetch(recorded, () => Response.json({ partialSuccess: {} })),
					),
					Effect.provide(tracer.layer),
				)

				assert.lengthOf(recorded, 1)
				const [span] = endedSpansNamed(tracer.ended, "OtlpIngest.send")
				assert.strictEqual(span!.attributes.get("maple.otlp.chunk_count"), 1)
				assert.strictEqual(span!.attributes.get("maple.otlp.chunks_delivered"), 1)
			}).pipe(Effect.provide(TestLayer)),
		)
	})
})
