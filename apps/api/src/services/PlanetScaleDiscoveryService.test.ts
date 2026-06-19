import { afterEach, describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { ConfigProvider, Duration, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { CreateScrapeTargetRequest, OrgId } from "@maple/domain/http"
import { DatabaseLibsqlLive } from "../lib/DatabaseLibsqlLive"
import { Env } from "../lib/Env"
import { cleanupTempDirs, createTempDbUrl as makeTempDb } from "../lib/test-sqlite"
import { PlanetScaleDiscoveryService } from "./PlanetScaleDiscoveryService"
import { ScrapeTargetsService } from "./ScrapeTargetsService"

const createdTempDirs: string[] = []
const originalFetch = globalThis.fetch

// create() forks a detached probe that uses the global fetch; stub it so the
// tests never touch the real network.
globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch

afterEach(() => {
	globalThis.fetch = originalFetch
	cleanupTempDirs(createdTempDirs)
})

const createTempDbUrl = () => makeTempDb("maple-ps-discovery-", createdTempDirs)

const makeConfig = (url: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_DB_URL: url,
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

// Single memoized discovery layer shared by both services, mirroring app.ts.
const makeLayer = (url: string) =>
	Layer.mergeAll(
		PlanetScaleDiscoveryService.layer,
		ScrapeTargetsService.layer.pipe(Layer.provide(PlanetScaleDiscoveryService.layer)),
	).pipe(Layer.provide(DatabaseLibsqlLive), Layer.provide(Env.layer), Layer.provide(makeConfig(url)))

const asOrgId = Schema.decodeUnknownSync(OrgId)

const SD_PAYLOAD = [
	{
		targets: ["branch-1.metrics.psdb.cloud:443"],
		labels: {
			__metrics_path__: "/metrics",
			planetscale_database_branch_id: "branch-1",
			planetscale_database: "mydb",
		},
	},
	{
		targets: ["branch-2.metrics.psdb.cloud:443"],
		labels: {
			planetscale_database_branch_id: "branch-2",
			planetscale_database: "mydb",
		},
	},
	{
		// SSRF guard: a discovered link-local target must be dropped.
		targets: ["169.254.169.254:80"],
		labels: { planetscale_database_branch_id: "evil" },
	},
]

interface RecordedRequest {
	readonly url: string
	readonly authorization: string | null
}

const stubFetch =
	(recorded: Array<RecordedRequest>, respond: () => Response): typeof fetch =>
	async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
		recorded.push({ url, authorization: headers.get("authorization") })
		return respond()
	}

const createPlanetScaleTargetRow = (organization: string) =>
	Effect.gen(function* () {
		const service = yield* ScrapeTargetsService
		const created = yield* service.create(
			asOrgId("org_1"),
			new CreateScrapeTargetRequest({
				name: "PlanetScale Prod",
				targetType: "planetscale",
				organization,
				authCredentials: JSON.stringify({ tokenId: "tok_id", tokenSecret: "tok_secret" }),
			}),
		)
		const rows = yield* service.listAllEnabled()
		const row = rows.find((candidate) => candidate.id === created.id)
		if (!row) return yield* Effect.die("created row not found")
		return row
	})

describe("PlanetScaleDiscoveryService", () => {
	it.effect("discovers sub-targets with the token auth scheme and strips meta labels", () => {
		const { url } = createTempDbUrl()
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")

			const entries = yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => Response.json(SD_PAYLOAD)),
				),
			)

			expect(recorded[0]?.url).toBe("https://api.planetscale.com/v1/organizations/my-org/metrics")
			expect(recorded[0]?.authorization).toBe("token tok_id:tok_secret")

			// The 169.254.* target is dropped by the SSRF guard.
			expect(entries.map((entry) => entry.subTargetKey)).toEqual(["branch-1", "branch-2"])
			expect(entries[0]?.url).toBe("https://branch-1.metrics.psdb.cloud:443/metrics")
			expect(entries[1]?.url).toBe("https://branch-2.metrics.psdb.cloud:443/metrics")
			// `__`-prefixed Prometheus meta labels are stripped; SD labels survive.
			expect(entries[0]?.labels).toEqual({
				planetscale_database_branch_id: "branch-1",
				planetscale_database: "mydb",
			})
		}).pipe(Effect.provide(makeLayer(url)))
	})

	it.effect("caches discovery for the TTL and refreshes after it elapses", () => {
		const { url } = createTempDbUrl()
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")
			const fetchStub = stubFetch(recorded, () => Response.json(SD_PAYLOAD))

			yield* discovery.discover(row).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			yield* discovery.discover(row).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			expect(recorded).toHaveLength(1)

			yield* TestClock.adjust(Duration.minutes(11))
			yield* discovery.discover(row).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			expect(recorded).toHaveLength(2)
		}).pipe(Effect.provide(makeLayer(url)))
	})

	it.effect("serves stale entries when a refresh fails and records the error", () => {
		const { url } = createTempDbUrl()
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")

			yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => Response.json(SD_PAYLOAD)),
				),
			)

			yield* TestClock.adjust(Duration.minutes(11))
			const stale = yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => new Response("nope", { status: 503 })),
				),
			)

			expect(stale.map((entry) => entry.subTargetKey)).toEqual(["branch-1", "branch-2"])
			const lastError = yield* discovery.lastError(row.id)
			expect(lastError).toContain("HTTP 503")
		}).pipe(Effect.provide(makeLayer(url)))
	})

	it.effect("fails with a clear token error when discovery is rejected and no cache exists", () => {
		const { url } = createTempDbUrl()
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")

			const error = yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch([], () => new Response("unauthorized", { status: 401 })),
				),
				Effect.flip,
			)

			expect(error.message).toContain("read_metrics_endpoints")
		}).pipe(Effect.provide(makeLayer(url)))
	})

	it.effect("invalidate drops the cache so the next discover refetches", () => {
		const { url } = createTempDbUrl()
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")
			const fetchStub = stubFetch(recorded, () => Response.json(SD_PAYLOAD))

			yield* discovery.discover(row).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			yield* discovery.invalidate(row.id)
			yield* discovery.discover(row).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			expect(recorded).toHaveLength(2)
		}).pipe(Effect.provide(makeLayer(url)))
	})
})
