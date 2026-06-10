import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ScraperEnv, type ScraperEnvShape } from "./Env"
import { TinybirdIngest } from "./TinybirdIngest"

const testEnv: ScraperEnvShape = {
	MAPLE_API_URL: "http://api.test",
	SD_INTERNAL_TOKEN: Redacted.make("internal-token"),
	TINYBIRD_HOST: "http://tb.test",
	TINYBIRD_TOKEN: Redacted.make("tb-token"),
	SCRAPER_CONCURRENCY: 10,
	SCRAPER_RECONCILE_INTERVAL_SECONDS: 60,
	PORT: 0,
}

const TestLayer = TinybirdIngest.layer.pipe(
	Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(ScraperEnv, testEnv))),
)

describe("TinybirdIngest", () => {
	it.effect("posts NDJSON to the events API with auth", () =>
		Effect.gen(function* () {
			const recorded: Array<{ url: string; body: string | null; headers: Record<string, string> }> = []
			const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
				const headers: Record<string, string> = {}
				new Headers(init?.headers).forEach((value, key) => {
					headers[key] = value
				})
				recorded.push({
					url: String(input),
					body:
						typeof init?.body === "string"
							? init.body
							: init?.body instanceof Uint8Array
								? new TextDecoder().decode(init.body)
								: null,
					headers,
				})
				return Response.json({ successful_rows: 2 })
			}) as typeof globalThis.fetch

			const tinybird = yield* TinybirdIngest
			yield* tinybird
				.ingest("metrics_gauge", [{ a: 1 }, { a: 2 }])
				.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))

			expect(recorded[0]?.url).toBe("http://tb.test/v0/events?name=metrics_gauge&wait=false")
			expect(recorded[0]?.headers.authorization).toBe("Bearer tb-token")
			expect(recorded[0]?.headers["content-type"]).toBe("application/x-ndjson")
			expect(recorded[0]?.body).toBe('{"a":1}\n{"a":2}')
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("skips empty batches without a request", () =>
		Effect.gen(function* () {
			let called = 0
			const fetchStub = (async (_input: string | URL | Request) => {
				called++
				return Response.json({})
			}) as typeof globalThis.fetch

			const tinybird = yield* TinybirdIngest
			yield* tinybird.ingest("metrics_gauge", []).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			expect(called).toBe(0)
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("fails with a typed error on non-2xx responses", () =>
		Effect.gen(function* () {
			const fetchStub = (async (_input: string | URL | Request) =>
				new Response("quarantined", { status: 422 })) as typeof globalThis.fetch

			const tinybird = yield* TinybirdIngest
			const error = yield* tinybird
				.ingest("metrics_sum", [{ a: 1 }])
				.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub), Effect.flip)

			expect(error._tag).toBe("@maple/scraper/TinybirdIngestError")
			expect(error.status).toBe(422)
			expect(error.message).toContain("metrics_sum")
		}).pipe(Effect.provide(TestLayer)),
	)
})
