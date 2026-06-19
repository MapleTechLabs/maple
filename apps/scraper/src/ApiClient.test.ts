import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ApiClient } from "./ApiClient"
import { ScraperEnv, type ScraperEnvShape } from "./Env"

const testEnv: ScraperEnvShape = {
	MAPLE_API_URL: "http://api.test",
	SD_INTERNAL_TOKEN: Redacted.make("internal-token"),
	MAPLE_INGEST_URL: "http://ingest.test",
	SCRAPER_CONCURRENCY: 10,
	SCRAPER_RECONCILE_INTERVAL_SECONDS: 60,
	PORT: 0,
}

const TestLayer = ApiClient.layer.pipe(
	Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(ScraperEnv, testEnv))),
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
	url: "https://node.example.com/metrics",
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

			expect(recorded[0]?.url).toBe("http://api.test/api/internal/scrape-targets")
			expect(recorded[0]?.headers.authorization).toBe("Bearer internal-token")
			expect(targets).toHaveLength(1)
			expect(targets[0]?.id).toBe(VALID_TARGET.id)
			expect(targets[0]?.labels).toEqual({ env: "prod" })
			expect(targets[0]?.ingestKey).toBe("maple_pk_org_1_key")
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
			expect(result._tag).toBe("@maple/scraper/ApiRequestError")
			expect(result.status).toBe(401)
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
			expect(result.message).toContain("payload mismatch")
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("scrapes a target through the proxy, passing the upstream status through", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const client = yield* ApiClient
			const response = yield* client.scrapeTarget("target-1").pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => new Response("# TYPE up gauge\nup 1", { status: 200 })),
				),
			)

			expect(recorded[0]?.url).toBe("http://api.test/api/internal/prometheus-scrape?targetId=target-1")
			expect(recorded[0]?.headers.authorization).toBe("Bearer internal-token")
			expect(response.status).toBe(200)
			expect(response.body).toContain("up 1")
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("passes the sub-target key to the proxy as the sub query param", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const client = yield* ApiClient
			yield* client.scrapeTarget("target-1", "branch a/1").pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => new Response("up 1", { status: 200 })),
				),
			)

			expect(recorded[0]?.url).toBe(
				"http://api.test/api/internal/prometheus-scrape?targetId=target-1&sub=branch%20a%2F1",
			)
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("posts scrape results as JSON and skips empty batches", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const client = yield* ApiClient
			const fetchStub = stubFetch(recorded, () => Response.json({ recorded: 1 }))

			yield* client.reportResults([]).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			expect(recorded).toHaveLength(0)

			yield* client
				.reportResults([
					{ targetId: VALID_TARGET.id, scrapedAt: 1750000000000, error: null } as never,
				])
				.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))

			expect(recorded[0]?.url).toBe("http://api.test/api/internal/scrape-results")
			expect(recorded[0]?.method).toBe("POST")
			expect(recorded[0]?.headers["content-type"]).toBe("application/json")
			expect(JSON.parse(recorded[0]?.body ?? "[]")).toEqual([
				{ targetId: VALID_TARGET.id, scrapedAt: 1750000000000, error: null },
			])
		}).pipe(Effect.provide(TestLayer)),
	)
})
