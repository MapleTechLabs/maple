import { FetchHttpClient } from "effect/http"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	CreateScrapeTargetRequest,
	OrgId,
	ScrapeIntervalSeconds,
	ScrapeTargetId,
	UpdateScrapeTargetRequest,
} from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { runScrapeCheckRetention } from "@maple/backend/services/integrations/scrape-check-retention"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	insertTestSource,
	makeStatementRecorder,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { PlanetScaleDiscoveryService } from "./PlanetScaleDiscoveryService"
import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { ScrapeTargetsService, summarizeScrapeResults } from "./ScrapeTargetsService"

const trackedDbs: TestDb[] = []
const originalFetch = globalThis.fetch

// create() forks a detached probe that uses the global fetch; stub it before
// EVERY test (afterEach restores the real fetch, so a module-level stub would
// only protect the first test) so the tests never touch the real network.
beforeEach(() => {
	globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch
})

afterEach(async () => {
	globalThis.fetch = originalFetch
	await cleanupTestDbs(trackedDbs)
})

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayer = (testDb: TestDb) => {
	const oauthLive = PlanetScaleOAuthService.layer
	return Layer.effect(ScrapeTargetsService, ScrapeTargetsService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(
			Layer.mergeAll(
				Layer.effect(PlanetScaleDiscoveryService, PlanetScaleDiscoveryService.make).pipe(
					Layer.provide(FetchHttpClient.layer),
					Layer.provide(oauthLive),
				),
				oauthLive,
				SupabaseOAuthService.layer,
			),
		),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig()),
	)
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asScrapeIntervalSeconds = Schema.decodeUnknownSync(ScrapeIntervalSeconds)
const asScrapeTargetId = Schema.decodeUnknownSync(ScrapeTargetId)

describe("ScrapeTargetsService", () => {
	it.effect("authHeaders decrypts a stored bearer credential into an Authorization header", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const target = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
					authType: "bearer",
					authCredentials: JSON.stringify({ token: "stored-token" }),
				}),
			)
			const row = (yield* service.listAllEnabled()).find((candidate) => candidate.id === target.id)
			assert.isDefined(row)
			if (!row) return

			const headers = yield* service.authHeaders(row)
			assert.deepStrictEqual(headers, { Authorization: "Bearer stored-token" })
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("creates each target with its own source and deletes the source with it", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const create = (orgId: string, name: string) =>
				service.create(
					asOrgId(orgId),
					new CreateScrapeTargetRequest({
						name,
						url: `https://${name}.example.com/metrics`,
						scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
					}),
				)
			const node = yield* create("org_1", "node")
			const other = yield* create("org_2", "node")
			const sources = () =>
				Effect.promise(() =>
					testDb.pglite.query<{
						org_id: string
						kind: string
						platform: string
						name: string
						target: string
					}>(
						`SELECT s.org_id, s.kind, s.platform, s.name, t.id AS target
						FROM sources s JOIN scrape_targets t ON t.source_id = s.id ORDER BY s.org_id`,
					),
				)
			assert.deepStrictEqual(
				(yield* sources()).rows.map((row) => [
					row.org_id,
					row.kind,
					row.platform,
					row.name,
					row.target,
				]),
				[
					["org_1", "integration", "prometheus", "node", node.id],
					["org_2", "integration", "prometheus", "node", other.id],
				],
			)

			yield* service.delete(asOrgId("org_1"), node.id)
			const left = yield* Effect.promise(() =>
				testDb.pglite.query<{ org_id: string }>("SELECT org_id FROM sources"),
			)
			assert.deepStrictEqual(
				left.rows.map((row) => row.org_id),
				["org_2"],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("listAllEnabled leaves out a target whose source is paused", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const create = (name: string) =>
				service.create(
					asOrgId("org_1"),
					new CreateScrapeTargetRequest({
						name,
						url: `https://${name}.example.com/metrics`,
						scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
					}),
				)
			const paused = yield* create("paused")
			const live = yield* create("live")
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"UPDATE sources SET paused_at = now() WHERE id = (SELECT source_id FROM scrape_targets WHERE id = $1)",
					[paused.id],
				),
			)
			assert.deepStrictEqual(
				(yield* service.listAllEnabled()).map((row) => row.id),
				[live.id],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("listAllEnabled lists a target whose stored labels are malformed, labels as stored", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const target = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE scrape_targets SET labels_json = $1::jsonb WHERE id = $2", [
					JSON.stringify({ team: 7 }),
					target.id,
				]),
			)
			const rows = yield* service.listAllEnabled()
			assert.deepStrictEqual(
				rows.map((row) => [row.id, row.labelsJson]),
				[[target.id, { team: 7 }]],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("recordScrapeResults updates lastScrapeAt on success and clears the error", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const scrapedAt = 1750000000000
			yield* service.recordScrapeResults([{ targetId: target.id, scrapedAt, error: null }])

			const updated = yield* service.get(orgId, target.id)
			assert.strictEqual(updated.lastScrapeAt, new Date(scrapedAt).toISOString())
			assert.isNull(updated.lastScrapeError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("recordScrapeResults keeps lastScrapeAt at the last good scrape on failure", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const goodScrapeAt = 1750000000000
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: goodScrapeAt, error: null },
			])
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: goodScrapeAt + 15_000, error: "HTTP 503" },
			])

			const updated = yield* service.get(orgId, target.id)
			assert.strictEqual(updated.lastScrapeAt, new Date(goodScrapeAt).toISOString())
			assert.strictEqual(updated.lastScrapeError, "HTTP 503")

			// A later success clears the error again.
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: goodScrapeAt + 30_000, error: null },
			])
			const recovered = yield* service.get(orgId, target.id)
			assert.strictEqual(recovered.lastScrapeAt, new Date(goodScrapeAt + 30_000).toISOString())
			assert.isNull(recovered.lastScrapeError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("recordScrapeResults reports each batch onto the target's source", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const create = (name: string) =>
				service.create(
					orgId,
					new CreateScrapeTargetRequest({
						name,
						url: `https://metrics.example.com/${name}`,
						scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
					}),
				)
			const api = yield* create("api")
			const worker = yield* create("worker")
			const readSource = () =>
				Effect.promise(() =>
					testDb.pglite.query<{
						last_poll_ok_at: Date | null
						last_poll_error: string | null
						poll_resources: { total: number; unhealthy: number } | null
					}>(
						"SELECT s.last_poll_ok_at, s.last_poll_error, s.poll_resources FROM sources s JOIN scrape_targets t ON t.source_id = s.id WHERE t.id = $1",
						[api.id],
					),
				).pipe(Effect.map((result) => result.rows[0]))

			yield* service.recordScrapeResults([{ targetId: api.id, scrapedAt: 1750000000000, error: null }])
			const healthy = yield* readSource()
			assert.isNotNull(healthy!.last_poll_ok_at)
			assert.isNull(healthy!.last_poll_error)
			assert.isNull(healthy!.poll_resources)

			yield* service.recordScrapeResults([
				{ targetId: api.id, scrapedAt: 1750000015000, error: "HTTP 503" },
			])
			assert.strictEqual((yield* readSource())!.last_poll_error, "HTTP 503")

			// Two targets on one source: the failure names its target and counts it unhealthy.
			yield* Effect.promise(() =>
				testDb.pglite.query(
					"UPDATE scrape_targets SET source_id = (SELECT source_id FROM scrape_targets WHERE id = $1) WHERE id = $2",
					[api.id, worker.id],
				),
			)
			yield* service.recordScrapeResults([
				{ targetId: api.id, scrapedAt: 1750000030000, error: null },
				{ targetId: worker.id, scrapedAt: 1750000030000, error: "HTTP 401" },
			])
			const shared = yield* readSource()
			assert.strictEqual(shared!.last_poll_error, "worker: HTTP 401")
			assert.deepStrictEqual(shared!.poll_resources, { total: 2, unhealthy: 1 })

			yield* service.recordScrapeResults([
				{ targetId: worker.id, scrapedAt: 1750000045000, error: null },
			])
			const recovered = yield* readSource()
			assert.isNull(recovered!.last_poll_error)
			assert.deepStrictEqual(recovered!.poll_resources, { total: 2, unhealthy: 0 })

			// A PlanetScale connection's target leaves its source to the connection's own poller.
			yield* Effect.promise(() =>
				testDb.pglite.query(
					"UPDATE scrape_targets SET managed_by = 'planetscale:conn_1' WHERE id = $1",
					[worker.id],
				),
			)
			yield* service.recordScrapeResults([
				{ targetId: worker.id, scrapedAt: 1750000200000, error: "HTTP 500" },
			])
			assert.isNull((yield* readSource())!.last_poll_error)

			// A probe of a switched-off target says nothing about its source.
			yield* Effect.promise(() =>
				testDb.pglite.query(
					"UPDATE scrape_targets SET managed_by = NULL, enabled = false WHERE id IN ($1, $2)",
					[api.id, worker.id],
				),
			)
			const before = yield* readSource()
			yield* TestClock.adjust("2 minutes")
			yield* service.recordScrapeResults([{ targetId: api.id, scrapedAt: 1750000300000, error: null }])
			assert.deepStrictEqual(yield* readSource(), before)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("recordScrapeResults tolerates unknown target ids and processes batches", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const unknownId = Schema.decodeUnknownSync(ScrapeTargetId)("99999999-9999-4999-8999-999999999999")
			const scrapedAt = 1750000000000
			yield* service.recordScrapeResults([
				{ targetId: unknownId, scrapedAt, error: null },
				{ targetId: target.id, scrapedAt, error: null },
			])

			const updated = yield* service.get(orgId, target.id)
			assert.strictEqual(updated.lastScrapeAt, new Date(scrapedAt).toISOString())
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("recordScrapeResults writes every target of a report in one UPDATE", () => {
		const testDb = createTestDb(trackedDbs)
		const recorder = makeStatementRecorder()
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			// One source for all six, as a PlanetScale connection's branch targets share one.
			const sourceId = yield* Effect.promise(() =>
				insertTestSource(testDb, { orgId, platform: "prometheus" }),
			)
			// Seeded with SQL, not create(), whose background probe would run its own
			// recordScrapeResults alongside the one under test.
			const [ok, failing, stale, ...rest] = yield* Effect.forEach(
				["ok", "failing", "stale", "t4", "t5", "t6"],
				(name, index) => {
					const id = asScrapeTargetId(`00000000-0000-4000-8000-00000000000${index}`)
					return Effect.as(
						Effect.promise(() =>
							executeSql(
								testDb,
								"INSERT INTO scrape_targets (id, org_id, source_id, name, url, created_at, updated_at) VALUES ($1, $2, $6, $3, $4, $5, $5)",
								[
									id,
									orgId,
									name,
									`https://${name}.example.com/metrics`,
									new Date(0).toISOString(),
									sourceId,
								],
							),
						),
						{ id },
					)
				},
			)
			const scrapedAt = 1750000000000
			// A newer write already landed on `stale`; the late batch must not touch it.
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE scrape_targets SET updated_at = $1 WHERE id = $2", [
					new Date(scrapedAt + 60_000).toISOString(),
					stale.id,
				]),
			)

			yield* service
				.recordScrapeResults([
					{ targetId: ok.id, scrapedAt, error: null },
					{ targetId: failing.id, scrapedAt, error: null },
					{ targetId: failing.id, scrapedAt: scrapedAt + 15_000, error: "HTTP 503" },
					{ targetId: stale.id, scrapedAt, error: "HTTP 500" },
					...rest.map((target) => ({ targetId: target.id, scrapedAt, error: null })),
				])
				.pipe(Effect.withTracer(recorder.tracer))
			// 6 targets of one source: 1 UPDATE, 1 SELECT (org and source ids), the source's targets and
			// poll state, 1 UPDATE of the source, then 1 INSERT (check rows).
			assert.deepStrictEqual(recorder.verbs(), [
				"UPDATE",
				"SELECT",
				"SELECT",
				"SELECT",
				"UPDATE",
				"INSERT",
			])

			const okRow = yield* service.get(orgId, ok.id)
			assert.strictEqual(okRow.lastScrapeAt, new Date(scrapedAt).toISOString())
			assert.isNull(okRow.lastScrapeError)
			const failingRow = yield* service.get(orgId, failing.id)
			assert.strictEqual(failingRow.lastScrapeAt, new Date(scrapedAt).toISOString())
			assert.strictEqual(failingRow.lastScrapeError, "HTTP 503")
			const staleRow = yield* service.get(orgId, stale.id)
			assert.isNull(staleRow.lastScrapeAt)
			assert.isNull(staleRow.lastScrapeError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("creates a PlanetScale target with a derived discovery URL and forced token auth", () => {
		const testDb = createTestDb(trackedDbs)
		globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const target = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "PlanetScale Prod",
					targetType: "planetscale",
					organization: "my-org",
					authCredentials: JSON.stringify({ tokenId: "tok_id", tokenSecret: "tok_secret" }),
				}),
			)

			assert.strictEqual(target.targetType, "planetscale")
			assert.strictEqual(target.organization, "my-org")
			assert.strictEqual(target.url, "https://api.planetscale.com/v1/organizations/my-org/metrics")
			assert.strictEqual(target.authType, "token")
			assert.isTrue(target.hasCredentials)
			// PlanetScale's documented default scrape interval.
			assert.strictEqual(target.scrapeIntervalSeconds, 30)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("rejects invalid PlanetScale create requests", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")

			const missingOrg = yield* service
				.create(
					orgId,
					new CreateScrapeTargetRequest({
						name: "PS",
						targetType: "planetscale",
						authCredentials: JSON.stringify({ tokenId: "a", tokenSecret: "b" }),
					}),
				)
				.pipe(Effect.flip)
			assert.include(missingOrg.message, "organization is required")

			const withUrl = yield* service
				.create(
					orgId,
					new CreateScrapeTargetRequest({
						name: "PS",
						targetType: "planetscale",
						organization: "my-org",
						url: "https://example.com/metrics",
						authCredentials: JSON.stringify({ tokenId: "a", tokenSecret: "b" }),
					}),
				)
				.pipe(Effect.flip)
			assert.include(withUrl.message, "do not provide a url")

			const badCredentials = yield* service
				.create(
					orgId,
					new CreateScrapeTargetRequest({
						name: "PS",
						targetType: "planetscale",
						organization: "my-org",
						authCredentials: JSON.stringify({ token: "not-a-service-token" }),
					}),
				)
				.pipe(Effect.flip)
			assert.include(badCredentials.message, "tokenId")

			const missingUrl = yield* service
				.create(orgId, new CreateScrapeTargetRequest({ name: "Prom" }))
				.pipe(Effect.flip)
			assert.include(missingUrl.message, "url is required")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("prefixes sub-target failures with the branch key in lastScrapeError", () => {
		const testDb = createTestDb(trackedDbs)
		globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "PlanetScale Prod",
					targetType: "planetscale",
					organization: "my-org",
					authCredentials: JSON.stringify({ tokenId: "a", tokenSecret: "b" }),
				}),
			)

			yield* service.recordScrapeResults([
				{
					targetId: target.id,
					scrapedAt: 1750000000000,
					error: "HTTP 503",
					subTargetKey: "branch-1",
				},
			])
			const failed = yield* service.get(orgId, target.id)
			assert.strictEqual(failed.lastScrapeError, "[branch:branch-1] HTTP 503")

			// Any branch success clears the rollup error.
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: 1750000015000, error: null, subTargetKey: "branch-2" },
			])
			const recovered = yield* service.get(orgId, target.id)
			assert.isNull(recovered.lastScrapeError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("persists scheduled check rows and lists them newest-first", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const scrapedAt = 1750000000000
			yield* TestClock.setTime(scrapedAt + 30_000)
			yield* service.recordScrapeResults([
				{
					targetId: target.id,
					scrapedAt,
					error: null,
					durationMs: 250,
					samplesScraped: 120,
					samplesPostMetricRelabeling: 118,
				},
				{
					targetId: target.id,
					scrapedAt: scrapedAt + 15_000,
					error: "target returned HTTP 503",
					subTargetKey: "branch-1",
					durationMs: 1100,
				},
			])

			const checks = yield* service.listChecks(orgId, target.id, {})
			assert.lengthOf(checks, 2)
			assert.strictEqual(checks[0]?.checkedAt, scrapedAt + 15_000)
			assert.strictEqual(checks[0]?.error, "target returned HTTP 503")
			assert.strictEqual(checks[0]?.subTargetKey, "branch-1")
			assert.strictEqual(checks[0]?.durationMs, 1100)
			assert.isNull(checks[0]?.samplesScraped)
			assert.strictEqual(checks[1]?.checkedAt, scrapedAt)
			assert.isNull(checks[1]?.error)
			assert.strictEqual(checks[1]?.subTargetKey, "")
			assert.strictEqual(checks[1]?.durationMs, 250)
			assert.strictEqual(checks[1]?.samplesScraped, 120)
			assert.strictEqual(checks[1]?.samplesPostRelabel, 118)

			// Time-range + limit filtering.
			const limited = yield* service.listChecks(orgId, target.id, { limit: 1 })
			assert.lengthOf(limited, 1)
			assert.strictEqual(limited[0]?.checkedAt, scrapedAt + 15_000)
			const secondPage = yield* service.listChecks(orgId, target.id, { limit: 1, offset: 1 })
			assert.lengthOf(secondPage, 1)
			assert.strictEqual(secondPage[0]?.checkedAt, scrapedAt)
			const windowed = yield* service.listChecks(orgId, target.id, {
				startTime: scrapedAt - 1,
				endTime: scrapedAt + 1,
			})
			assert.lengthOf(windowed, 1)
			assert.strictEqual(windowed[0]?.checkedAt, scrapedAt)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("manual probes update the target but record no check rows", () => {
		const testDb = createTestDb(trackedDbs)
		const fetchStub = (async () => new Response("up 1\n", { status: 200 })) as typeof fetch
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			yield* TestClock.setTime(1750000000000)
			const probed = yield* service
				.probe(orgId, target.id)
				.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			assert.isTrue(probed.success)
			assert.isNotNull(probed.lastScrapeAt)

			const checks = yield* service.listChecks(orgId, target.id, {})
			assert.lengthOf(checks, 0)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("manual probes persist safe upstream messages without stack traces", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const fetchStub = (async () => {
				throw new Error("socket exploded")
			}) as typeof fetch

			const probed = yield* service
				.probe(orgId, target.id)
				.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			assert.isFalse(probed.success)
			assert.strictEqual(probed.lastScrapeError, "socket exploded")
			assert.notInclude(probed.lastScrapeError ?? "", "ScrapeTargetsService.ts")

			const checks = yield* service.listChecks(orgId, target.id, {})
			assert.lengthOf(checks, 0)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("manual probes fail a 200 that carries no Prometheus metrics", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			globalThis.fetch = (async () =>
				new Response("<html>login</html>", { status: 200 })) as typeof fetch
			const probed = yield* service.probe(orgId, target.id)
			assert.isFalse(probed.success)
			assert.strictEqual(probed.lastScrapeError, "Response contained no Prometheus metrics")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("recording results no longer prunes — retention is the cron's job", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const now = 1750000000000
			yield* TestClock.setTime(now)
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: now - 25 * 60 * 60 * 1000, error: null },
				{ targetId: target.id, scrapedAt: now - 60 * 60 * 1000, error: null },
			])

			// The write path is now pure: both rows land, including the expired one.
			const checks = yield* service.listChecks(orgId, target.id, {})
			assert.lengthOf(checks, 2)

			// …and the cron reclaims the expired row.
			yield* runScrapeCheckRetention
			const pruned = yield* service.listChecks(orgId, target.id, {})
			assert.lengthOf(pruned, 1)
			assert.strictEqual(pruned[0]?.checkedAt, now - 60 * 60 * 1000)
			// `makeLayer` consumes the db layer; the retention job needs `Database` directly.
		}).pipe(Effect.provide(Layer.mergeAll(makeLayer(testDb), testDb.layer)))
	})

	it.effect("folds a batch of results per target into one final row state", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const now = 1750000000000
			yield* TestClock.setTime(now)
			// Sequential application semantics: the last success sets lastScrapeAt and
			// clears the error, then a later failure re-sets the error while leaving
			// lastScrapeAt on the last good scrape.
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: now - 3000, error: "first boom" },
				{ targetId: target.id, scrapedAt: now - 2000, error: null },
				{ targetId: target.id, scrapedAt: now - 1000, error: "later boom" },
			])

			const after = yield* service.get(orgId, target.id)
			assert.strictEqual(after.lastScrapeError, "later boom")
			assert.strictEqual(
				after.lastScrapeAt === null ? null : new Date(after.lastScrapeAt).getTime(),
				now - 2000,
			)
			// Every result still gets its own check row.
			const checks = yield* service.listChecks(orgId, target.id, {})
			assert.lengthOf(checks, 3)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("listChecks rejects targets that belong to another org", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const target = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const error = yield* service.listChecks(asOrgId("org_2"), target.id, {}).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/ScrapeTargetNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("delete removes the target and returns its id; a later get is NotFound", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const deleted = yield* service.delete(orgId, target.id)
			assert.strictEqual(deleted.id, target.id)

			const afterList = yield* service.list(orgId)
			assert.lengthOf(afterList.targets, 0)
			const getError = yield* service.get(orgId, target.id).pipe(Effect.flip)
			assert.strictEqual(getError._tag, "@maple/http/errors/ScrapeTargetNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("delete rejects a target owned by another org and leaves it intact", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const target = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const error = yield* service.delete(asOrgId("org_2"), target.id).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/ScrapeTargetNotFoundError")

			// The owning org still sees it.
			const stillThere = yield* service.get(asOrgId("org_1"), target.id)
			assert.strictEqual(stillThere.id, target.id)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("planetscale targets accept credential-less planetscale_oauth auth", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const target = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "Managed PlanetScale",
					targetType: "planetscale",
					organization: "acme",
					authType: "planetscale_oauth",
				}),
			)
			assert.strictEqual(target.authType, "planetscale_oauth")
			assert.isFalse(target.hasCredentials)

			// Switching a token row to planetscale_oauth clears the stored credentials.
			const tokenTarget = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "Manual PlanetScale",
					targetType: "planetscale",
					organization: "other-org",
					authType: "token",
					authCredentials: JSON.stringify({ tokenId: "tok", tokenSecret: "sec" }),
				}),
			)
			assert.isTrue(tokenTarget.hasCredentials)
			const switched = yield* service.update(asOrgId("org_1"), tokenTarget.id, {
				authType: "planetscale_oauth",
			})
			assert.strictEqual(switched.authType, "planetscale_oauth")
			assert.isFalse(switched.hasCredentials)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses to carry stored credentials to a new origin", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					authType: "bearer",
					authCredentials: JSON.stringify({ token: "stored-token" }),
				}),
			)
			assert.isTrue(target.hasCredentials)

			// Repointing at an attacker-controlled host without re-supplying the
			// credential is exactly the exfiltration path: it must not persist.
			const error = yield* service
				.update(
					orgId,
					target.id,
					new UpdateScrapeTargetRequest({ url: "https://attacker.example.com/metrics" }),
				)
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/ScrapeTargetValidationError")
			assert.include(error.message, "re-supplying authCredentials")

			const unchanged = yield* service.get(orgId, target.id)
			assert.strictEqual(unchanged.url, "https://metrics.example.com/metrics")
			assert.isTrue(unchanged.hasCredentials)

			// A port change is an origin change too.
			const portError = yield* service
				.update(
					orgId,
					target.id,
					new UpdateScrapeTargetRequest({ url: "https://metrics.example.com:8443/metrics" }),
				)
				.pipe(Effect.flip)
			assert.strictEqual(portError._tag, "@maple/http/errors/ScrapeTargetValidationError")

			// Same origin, different path: nothing moves, so the credential stays.
			const samePath = yield* service.update(
				orgId,
				target.id,
				new UpdateScrapeTargetRequest({ url: "https://metrics.example.com/other" }),
			)
			assert.strictEqual(samePath.url, "https://metrics.example.com/other")
			assert.isTrue(samePath.hasCredentials)

			// Re-supplying the credential in the same request is the way across.
			const moved = yield* service.update(
				orgId,
				target.id,
				new UpdateScrapeTargetRequest({
					url: "https://other.example.com/metrics",
					authCredentials: JSON.stringify({ token: "fresh-token" }),
				}),
			)
			assert.strictEqual(moved.url, "https://other.example.com/metrics")
			assert.isTrue(moved.hasCredentials)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses generic update/delete against an integration-managed target", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Managed target",
					url: "https://metrics.example.com/metrics",
				}),
			)
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE scrape_targets SET managed_by = $1 WHERE id = $2", [
					"planetscale:conn_1",
					target.id,
				]),
			)

			const updateError = yield* service
				.update(orgId, target.id, new UpdateScrapeTargetRequest({ enabled: false }))
				.pipe(Effect.flip)
			assert.strictEqual(updateError._tag, "@maple/http/errors/ScrapeTargetValidationError")
			assert.include(updateError.message, "managed by an integration")

			const deleteError = yield* service.delete(orgId, target.id).pipe(Effect.flip)
			assert.strictEqual(deleteError._tag, "@maple/http/errors/ScrapeTargetValidationError")

			// The owning integration still writes through.
			const disabled = yield* service.update(
				orgId,
				target.id,
				new UpdateScrapeTargetRequest({ enabled: false }),
				{ allowManaged: true },
			)
			assert.isFalse(disabled.enabled)
			const deleted = yield* service.delete(orgId, target.id, { allowManaged: true })
			assert.strictEqual(deleted.id, target.id)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("prometheus targets reject the planetscale_oauth auth type", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const error = yield* service
				.create(
					asOrgId("org_1"),
					new CreateScrapeTargetRequest({
						name: "Node Exporter",
						url: "https://metrics.example.com/metrics",
						authType: "planetscale_oauth",
					}),
				)
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/ScrapeTargetValidationError")
			assert.include(error.message, "only valid for PlanetScale targets")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})

describe("summarizeScrapeResults", () => {
	it("folds each target's results in input order without losing the newest report", () => {
		const a = asScrapeTargetId("11111111-1111-4111-8111-111111111111")
		const b = asScrapeTargetId("22222222-2222-4222-8222-222222222222")
		const summary = summarizeScrapeResults([
			{ targetId: a, scrapedAt: 3_000, error: null },
			{ targetId: b, scrapedAt: 2_000, error: "timeout", subTargetKey: "main" },
			{ targetId: a, scrapedAt: 1_000, error: "connection refused" },
			{ targetId: b, scrapedAt: 1_500, error: "boom" },
		])

		assert.strictEqual(summary.size, 2)
		// Success then failure: the error wins, lastScrapeAt stays at the good scrape,
		// updatedAt follows the last applied result while reportedAt is the max.
		assert.deepStrictEqual(summary.get(a), {
			lastScrapeAt: 3_000,
			lastScrapeError: "connection refused",
			updatedAt: 1_000,
			reportedAt: 3_000,
		})
		assert.deepStrictEqual(summary.get(b), {
			lastScrapeAt: null,
			lastScrapeError: "boom",
			updatedAt: 1_500,
			reportedAt: 2_000,
		})
	})
})
