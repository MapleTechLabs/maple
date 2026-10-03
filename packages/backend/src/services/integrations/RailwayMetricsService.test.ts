import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { nextWindow, RailwayMetricsService } from "./RailwayMetricsService"

const now = Date.UTC(2026, 9, 3, 12, 30, 30)
const minute = 60_000

describe("nextWindow", () => {
	it("backfills one hour on a fresh environment, ending two minutes behind now on a sample boundary", () => {
		const window = nextWindow(null, now)
		const end = Date.UTC(2026, 9, 3, 12, 28, 0)
		assert.deepStrictEqual(window, { startMs: end - 60 * minute, endMs: end })
	})

	it("continues from the watermark", () => {
		const watermark = new Date(Date.UTC(2026, 9, 3, 12, 20, 0))
		assert.deepStrictEqual(nextWindow(watermark, now), {
			startMs: watermark.getTime(),
			endMs: Date.UTC(2026, 9, 3, 12, 28, 0),
		})
	})

	it("returns null when the environment is caught up", () => {
		assert.strictEqual(nextWindow(new Date(Date.UTC(2026, 9, 3, 12, 28, 0)), now), null)
	})

	it("catches up a long gap six hours at a time from the watermark, skipping nothing", () => {
		const watermark = new Date(now - 48 * 60 * minute)
		const window = nextWindow(watermark, now)
		assert.deepStrictEqual(window, {
			startMs: watermark.getTime(),
			endMs: watermark.getTime() + 6 * 60 * minute,
		})
	})
})

const trackedDbs: TestDb[] = []
const originalFetch = globalThis.fetch

afterEach(async () => {
	globalThis.fetch = originalFetch
	await cleanupTestDbs(trackedDbs)
})

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_INGEST_PUBLIC_URL: "https://ingest.test",
		}),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

interface StubOptions {
	/** Response for any Railway call: "ok", a GraphQL auth error, or HTTP 429. */
	readonly railway?: "ok" | "unauthorized" | "rate_limited"
	readonly ingestStatus?: number
	/** Pages of the `projects` connection, served by cursor. Defaults to one page with `shop`. */
	readonly projectPages?: ReadonlyArray<ReadonlyArray<ProjectNode>>
}

interface ProjectNode {
	readonly id: string
	readonly name: string
	readonly environments: ReadonlyArray<{
		readonly id: string
		readonly name: string
		readonly isEphemeral: boolean
	}>
}

const SHOP: ProjectNode = {
	id: "prj_1",
	name: "shop",
	environments: [
		{ id: "env_prod", name: "production", isEphemeral: false },
		{ id: "env_pr", name: "pr-12", isEphemeral: true },
	],
}

const projectEdge = (project: ProjectNode) => ({
	node: {
		id: project.id,
		name: project.name,
		environments: { edges: project.environments.map((node) => ({ node })) },
		services: { edges: [{ node: { id: "svc_api", name: "api" } }] },
	},
})

interface StubCalls {
	readonly railway: Array<{ readonly query: string; readonly authorization: string | null }>
	readonly ingest: Array<{ readonly body: unknown; readonly authorization: string | null }>
}

const decodeRequestBody = Schema.decodeUnknownSync(
	Schema.fromJsonString(
		Schema.Struct({
			query: Schema.optionalKey(Schema.String),
			variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
		}),
	),
)

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const stubFetch = (calls: StubCalls, options: StubOptions = {}) => {
	const stub = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
		const headers = new Headers(init?.headers)
		const body = decodeRequestBody(await new Response(init?.body ?? null).text())
		if (new URL(url).host === "ingest.test") {
			calls.ingest.push({ body, authorization: headers.get("authorization") })
			return json({}, options.ingestStatus ?? 200)
		}
		const query = body.query ?? ""
		calls.railway.push({ query, authorization: headers.get("authorization") })
		if (options.railway === "rate_limited") {
			return new Response("slow down", { status: 429, headers: { "retry-after": "60" } })
		}
		if (options.railway === "unauthorized") return json({ errors: [{ message: "Not Authorized" }] })
		if (query.includes("apiToken")) {
			return json({ data: { apiToken: { workspaces: [{ id: "ws_1", name: "Acme" }] } } })
		}
		if (query.includes("projects(")) {
			const pages = options.projectPages ?? [[SHOP]]
			const cursor = Object.values(body.variables ?? {}).find(
				(value): value is string => typeof value === "string" && value.startsWith("cursor_"),
			)
			const page = cursor === undefined ? 0 : Number(cursor.slice("cursor_".length))
			const hasNextPage = page + 1 < pages.length
			return json({
				data: {
					projects: {
						edges: (pages[page] ?? []).map(projectEdge),
						pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor_${page + 1}` : null },
					},
				},
			})
		}
		// Inside the first poll's window [11:28, 12:28).
		const ts = Date.UTC(2026, 9, 3, 12, 0, 0) / 1000
		return json({
			data: {
				metrics: [
					{
						measurement: "CPU_USAGE",
						tags: { serviceId: "svc_api", deploymentInstanceId: "rep_1", region: null },
						values: [
							{ ts, value: 0.5 },
							{ ts: ts + 60, value: 0.75 },
						],
					},
				],
			},
		})
	}) as typeof fetch
	globalThis.fetch = stub
	return stub
}

const makeLayer = (testDb: TestDb, stub: typeof fetch) =>
	Layer.effect(RailwayMetricsService, RailwayMetricsService.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, OrgIngestKeysService.layer)),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, stub)),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig()),
	)

const run = <A, E>(testDb: TestDb, stub: typeof fetch, effect: Effect.Effect<A, E, RailwayMetricsService>) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(now)
		return yield* effect
	}).pipe(Effect.provideService(FetchHttpClient.Fetch, stub), Effect.provide(makeLayer(testDb, stub)))

describe("RailwayMetricsService", () => {
	const orgId = asOrgId("org_railway")
	const userId = asUserId("user_1")

	it.effect("connect stores an encrypted token and discovers non-ephemeral environments", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: StubCalls = { railway: [], ingest: [] }
		const stub = stubFetch(calls)
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				const railway = yield* RailwayMetricsService
				const status = yield* railway.connect(orgId, userId, "  rw_token_123  ")
				assert.isTrue(status.connected)
				assert.strictEqual(status.workspaceNames, "Acme")
				assert.deepStrictEqual(
					status.environments.map((environment) => [
						environment.environmentName,
						environment.serviceCount,
					]),
					[["production", 1]],
				)
				assert.isTrue(calls.railway.every((call) => call.authorization === "Bearer rw_token_123"))
				// The metrics probe ran before the token was saved.
				assert.isTrue(calls.railway.some((call) => call.query.includes("metrics(")))
				const row = yield* Effect.promise(() =>
					queryFirstRow<{ token_ciphertext: string }>(
						testDb,
						"SELECT token_ciphertext FROM railway_connections WHERE org_id = $1",
						[orgId],
					),
				)
				assert.notInclude(row!.token_ciphertext, "rw_token_123")
			}),
		)
	})

	it.effect("connect rejects a token Railway does not accept", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubFetch({ railway: [], ingest: [] }, { railway: "unauthorized" })
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				const railway = yield* RailwayMetricsService
				const exit = yield* Effect.exit(railway.connect(orgId, userId, "rw_bad_token"))
				assert.isTrue(Exit.isFailure(exit))
				const status = yield* railway.getStatus(orgId)
				assert.isFalse(status.connected)
			}),
		)
	})

	it.effect("pollOrg ships in-window samples to ingest and advances the watermark", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: StubCalls = { railway: [], ingest: [] }
		const stub = stubFetch(calls)
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				const railway = yield* RailwayMetricsService
				yield* railway.connect(orgId, userId, "rw_token_123")
				const summary = yield* railway.pollOrg(orgId)
				assert.strictEqual(summary.skipped, null)
				assert.strictEqual(summary.rowsIngested, 2)
				assert.strictEqual(calls.ingest.length, 1)
				assert.match(calls.ingest[0]!.authorization ?? "", /^Bearer maple_pk_/)

				const environment = yield* Effect.promise(() =>
					queryFirstRow<{ watermark_at: Date }>(
						testDb,
						"SELECT watermark_at FROM railway_environments WHERE environment_id = 'env_prod'",
					),
				)
				assert.strictEqual(
					new Date(environment!.watermark_at).getTime(),
					Date.UTC(2026, 9, 3, 12, 28, 0),
				)

				// Caught up: a second poll in the same minute makes no Railway calls.
				const again = yield* railway.pollOrg(orgId)
				assert.strictEqual(again.callsMade, 0)
				assert.strictEqual(calls.ingest.length, 1)
			}),
		)
	})

	it.effect("a rate-limited poll holds the lease and leaves the watermark alone", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: StubCalls = { railway: [], ingest: [] }
		return Effect.gen(function* () {
			const okStub = stubFetch(calls)
			yield* run(
				testDb,
				okStub,
				RailwayMetricsService.use((railway) => railway.connect(orgId, userId, "rw_token_123")),
			)
			const limitedStub = stubFetch(calls, { railway: "rate_limited" })
			// The SDK retries a 429 with backoff before giving up; let its sleeps elapse.
			const summary = yield* run(
				testDb,
				limitedStub,
				Effect.gen(function* () {
					const fiber = yield* Effect.forkChild(
						RailwayMetricsService.use((railway) => railway.pollOrg(orgId)),
					)
					yield* TestClock.adjust("1 minute")
					return yield* Fiber.join(fiber)
				}),
			)
			assert.strictEqual(summary.failures, 1)
			const rows = yield* Effect.promise(() =>
				Promise.all([
					queryFirstRow<{ lease_until: Date | null }>(
						testDb,
						"SELECT lease_until FROM railway_connections WHERE org_id = $1",
						[orgId],
					),
					queryFirstRow<{ watermark_at: Date | null }>(
						testDb,
						"SELECT watermark_at FROM railway_environments WHERE environment_id = 'env_prod'",
					),
				]),
			)
			assert.isAbove(new Date(rows[0]!.lease_until!).getTime(), now + 10 * minute)
			assert.isNull(rows[1]!.watermark_at)
			const held = yield* run(
				testDb,
				limitedStub,
				RailwayMetricsService.use((railway) => railway.pollOrg(orgId)),
			)
			assert.strictEqual(held.skipped, "lease held")
		})
	})

	it.effect("a token rejected while polling pauses the connection", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: StubCalls = { railway: [], ingest: [] }
		return Effect.gen(function* () {
			const okStub = stubFetch(calls)
			yield* run(
				testDb,
				okStub,
				RailwayMetricsService.use((railway) => railway.connect(orgId, userId, "rw_token_123")),
			)
			const revokedStub = stubFetch(calls, { railway: "unauthorized" })
			yield* run(
				testDb,
				revokedStub,
				RailwayMetricsService.use((railway) => railway.pollOrg(orgId)),
			)
			const status = yield* run(
				testDb,
				revokedStub,
				RailwayMetricsService.use((railway) => railway.getStatus(orgId)),
			)
			assert.isTrue(status.authFailed)
			const all = yield* run(
				testDb,
				revokedStub,
				RailwayMetricsService.use((railway) => railway.pollAllOrgs()),
			)
			assert.strictEqual(all.orgs, 0)
		})
	})

	it.effect("discovery follows the projects cursor across pages", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: StubCalls = { railway: [], ingest: [] }
		const blog: ProjectNode = {
			id: "prj_2",
			name: "blog",
			environments: [{ id: "env_blog", name: "production", isEphemeral: false }],
		}
		const stub = stubFetch(calls, { projectPages: [[SHOP], [blog]] })
		return run(
			testDb,
			stub,
			Effect.gen(function* () {
				const railway = yield* RailwayMetricsService
				const status = yield* railway.connect(orgId, userId, "rw_token_123")
				assert.deepStrictEqual(
					status.environments.map((environment) => environment.projectName),
					["blog", "shop"],
				)
			}),
		)
	})

	it.effect("a full environment page keeps the environments it could not see", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: StubCalls = { railway: [], ingest: [] }
		const fullPage: ProjectNode = {
			...SHOP,
			environments: Array.from({ length: 100 }, (_, index) => ({
				id: `env_${index}`,
				name: `env-${index}`,
				isEphemeral: false,
			})),
		}
		const shortPage: ProjectNode = {
			...SHOP,
			environments: [{ id: "env_0", name: "env-0", isEphemeral: false }],
		}
		const hasProd = (status: {
			readonly environments: ReadonlyArray<{ readonly environmentId: string }>
		}) => status.environments.some((environment) => environment.environmentId === "env_prod")
		return Effect.gen(function* () {
			const connect = RailwayMetricsService.use((railway) =>
				railway.connect(orgId, userId, "rw_token_123"),
			)
			yield* run(testDb, stubFetch(calls), connect)
			// A full page may be truncated, so env_prod (missing from it) stays enabled.
			assert.isTrue(
				hasProd(yield* run(testDb, stubFetch(calls, { projectPages: [[fullPage]] }), connect)),
			)
			// A short page is complete, so env_prod is disabled.
			assert.isFalse(
				hasProd(yield* run(testDb, stubFetch(calls, { projectPages: [[shortPage]] }), connect)),
			)
		})
	})
})
