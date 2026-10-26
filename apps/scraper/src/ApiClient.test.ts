import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { ApiClient } from "./ApiClient"
import { ScraperEnv, type ScraperEnvConfig } from "./Env"

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

const TestLayer = ApiClient.layer.pipe(
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

interface RecordedRequest {
	url: string
	method: string
	headers: Record<string, string>
	body: string | null
}

const stubFetch = (
	recorded: Array<RecordedRequest>,
	respond: (url: string) => Response,
): typeof globalThis.fetch =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input)
		const headers: Record<string, string> = {}
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value
		})
		recorded.push({
			url,
			method: init?.method ?? "GET",
			headers,
			body:
				typeof init?.body === "string"
					? init.body
					: init?.body instanceof Uint8Array
						? new TextDecoder().decode(init.body)
						: null,
		})
		return respond(url)
	}) as typeof globalThis.fetch

const VALID_TARGET = {
	id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	orgId: "org_1",
	name: "Node",
	serviceName: "node",
	targetType: "prometheus",
	url: "https://node.example.com/metrics",
	scrapeUrl: "https://node.example.com/metrics",
	authHeaders: { Authorization: "Bearer stored-token" },
	subTargetKey: null,
	scrapeIntervalSeconds: 15,
	labels: { env: "prod" },
	ingestKey: "maple_pk_org_1_key",
}

describe("ApiClient", () => {
	it.effect("lists targets with the internal bearer and decodes the payload", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const client = yield* ApiClient
			const targets = yield* client.listTargets().pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => Response.json([VALID_TARGET])),
				),
			)

			assert.strictEqual(recorded[0]?.url, "http://api.test/api/internal/scrape-targets")
			assert.strictEqual(recorded[0]?.headers.authorization, "Bearer internal-token")
			assert.lengthOf(targets, 1)
			assert.strictEqual(targets[0]?.id, VALID_TARGET.id)
			assert.deepStrictEqual(targets[0]?.labels, { env: "prod" })
			assert.strictEqual(targets[0]?.ingestKey, "maple_pk_org_1_key")
			assert.deepStrictEqual(targets[0]?.authHeaders, { Authorization: "Bearer stored-token" })
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("fails with a typed error on non-2xx target list responses", () =>
		Effect.gen(function* () {
			const client = yield* ApiClient
			const result = yield* client.listTargets().pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch([], () => new Response("nope", { status: 401 })),
				),
				Effect.flip,
			)
			assert.strictEqual(result._tag, "@maple/scraper/ApiRequestError")
			assert.strictEqual(result.status, 401)
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("fails with a typed error when the payload does not match the schema", () =>
		Effect.gen(function* () {
			const client = yield* ApiClient
			const result = yield* client.listTargets().pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch([], () => Response.json([{ nonsense: true }])),
				),
				Effect.flip,
			)
			assert.include(result.message, "payload mismatch")
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("posts scrape results as JSON and skips empty batches", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const client = yield* ApiClient
			const fetchStub = stubFetch(recorded, () => Response.json({ recorded: 1 }))

			yield* client.reportResults([]).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			assert.lengthOf(recorded, 0)

			yield* client
				.reportResults([
					{ targetId: VALID_TARGET.id, scrapedAt: 1750000000000, error: null } as never,
				])
				.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))

			assert.strictEqual(recorded[0]?.url, "http://api.test/api/internal/scrape-results")
			assert.strictEqual(recorded[0]?.method, "POST")
			assert.strictEqual(recorded[0]?.headers["content-type"], "application/json")
			assert.deepStrictEqual(JSON.parse(recorded[0]?.body ?? "[]"), [
				{ targetId: VALID_TARGET.id, scrapedAt: 1750000000000, error: null },
			])
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("surfaces a 503 result-persistence response once retries run out", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const client = yield* ApiClient
			const fiber = yield* Effect.forkChild(
				client
					.reportResults([
						{ targetId: VALID_TARGET.id, scrapedAt: 1750000000000, error: null } as never,
					])
					.pipe(
						Effect.provideService(
							FetchHttpClient.Fetch,
							stubFetch(
								recorded,
								() => new Response("persistence unavailable", { status: 503 }),
							),
						),
						Effect.flip,
					),
			)
			yield* settleAndAdvance(3)
			const error = yield* Fiber.join(fiber)

			assert.strictEqual(error._tag, "@maple/scraper/ApiRequestError")
			assert.strictEqual(error.status, 503)
			assert.lengthOf(recorded, 3)
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("does not re-post results after a dropped connection, which may have landed", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const client = yield* ApiClient
			const error = yield* client
				.reportResults([
					{ targetId: VALID_TARGET.id, scrapedAt: 1750000000000, error: null } as never,
				])
				.pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						stubFetch(recorded, () => {
							throw new TypeError("connection reset")
						}),
					),
					Effect.flip,
				)
			assert.strictEqual(error.status, null)
			assert.lengthOf(recorded, 1)
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("retries a dropped connection when listing targets", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const client = yield* ApiClient
			const fiber = yield* Effect.forkChild(
				client.listTargets().pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						stubFetch(recorded, () => {
							if (recorded.length === 1) throw new TypeError("connection reset")
							return Response.json([VALID_TARGET])
						}),
					),
				),
			)
			yield* settleAndAdvance(2)
			const targets = yield* Fiber.join(fiber)
			assert.lengthOf(recorded, 2)
			assert.lengthOf(targets, 1)
		}).pipe(Effect.provide(TestLayer)),
	)
})
