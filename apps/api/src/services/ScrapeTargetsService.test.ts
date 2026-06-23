import { afterEach, describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CreateScrapeTargetRequest, OrgId, ScrapeIntervalSeconds, ScrapeTargetId } from "@maple/domain/http"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import { PlanetScaleDiscoveryService } from "./PlanetScaleDiscoveryService"
import { ScrapeTargetsService } from "./ScrapeTargetsService"

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

const makeLayer = (testDb: TestDb) =>
	ScrapeTargetsService.layer.pipe(
		Layer.provide(PlanetScaleDiscoveryService.layer),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig()),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asScrapeIntervalSeconds = Schema.decodeUnknownSync(ScrapeIntervalSeconds)

describe("ScrapeTargetsService", () => {
	it.effect("scrapeForCollector applies stored bearer credentials", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<{ url: string; authorization: string | null }> = []

		globalThis.fetch = (async (input, init) => {
			const requestUrl =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
			const headers = new Headers(init?.headers)
			calls.push({
				url: requestUrl,
				authorization: headers.get("authorization"),
			})
			return new Response("up 1\n", {
				status: 200,
				headers: { "content-type": "text/plain; version=0.0.4" },
			})
		}) as typeof fetch

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

			const response = yield* service.scrapeForCollector(target.id)

			expect(response.status).toBe(200)
			expect(response.body).toBe("up 1\n")
			expect(response.contentType).toBe("text/plain; version=0.0.4")
			expect(calls.some((call) => call.url === "https://metrics.example.com/metrics")).toBe(true)
			expect(calls.every((call) => call.authorization === "Bearer stored-token")).toBe(true)
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
			expect(updated.lastScrapeAt).toBe(new Date(scrapedAt).toISOString())
			expect(updated.lastScrapeError).toBeNull()
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
			expect(updated.lastScrapeAt).toBe(new Date(goodScrapeAt).toISOString())
			expect(updated.lastScrapeError).toBe("HTTP 503")

			// A later success clears the error again.
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: goodScrapeAt + 30_000, error: null },
			])
			const recovered = yield* service.get(orgId, target.id)
			expect(recovered.lastScrapeAt).toBe(new Date(goodScrapeAt + 30_000).toISOString())
			expect(recovered.lastScrapeError).toBeNull()
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
			expect(updated.lastScrapeAt).toBe(new Date(scrapedAt).toISOString())
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

			expect(target.targetType).toBe("planetscale")
			expect(target.organization).toBe("my-org")
			expect(target.url).toBe("https://api.planetscale.com/v1/organizations/my-org/metrics")
			expect(target.authType).toBe("token")
			expect(target.hasCredentials).toBe(true)
			// PlanetScale's documented default scrape interval.
			expect(target.scrapeIntervalSeconds).toBe(30)
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
			expect(missingOrg.message).toContain("organization is required")

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
			expect(withUrl.message).toContain("do not provide a url")

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
			expect(badCredentials.message).toContain("tokenId")

			const missingUrl = yield* service
				.create(orgId, new CreateScrapeTargetRequest({ name: "Prom" }))
				.pipe(Effect.flip)
			expect(missingUrl.message).toContain("url is required")
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
			expect(failed.lastScrapeError).toBe("[branch:branch-1] HTTP 503")

			// Any branch success clears the rollup error.
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: 1750000015000, error: null, subTargetKey: "branch-2" },
			])
			const recovered = yield* service.get(orgId, target.id)
			expect(recovered.lastScrapeError).toBeNull()
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
			expect(checks).toHaveLength(2)
			expect(checks[0]?.checkedAt.getTime()).toBe(scrapedAt + 15_000)
			expect(checks[0]?.error).toBe("target returned HTTP 503")
			expect(checks[0]?.subTargetKey).toBe("branch-1")
			expect(checks[0]?.durationMs).toBe(1100)
			expect(checks[0]?.samplesScraped).toBeNull()
			expect(checks[1]?.checkedAt.getTime()).toBe(scrapedAt)
			expect(checks[1]?.error).toBeNull()
			expect(checks[1]?.subTargetKey).toBe("")
			expect(checks[1]?.durationMs).toBe(250)
			expect(checks[1]?.samplesScraped).toBe(120)
			expect(checks[1]?.samplesPostRelabel).toBe(118)

			// Time-range + limit filtering.
			const limited = yield* service.listChecks(orgId, target.id, { limit: 1 })
			expect(limited).toHaveLength(1)
			expect(limited[0]?.checkedAt.getTime()).toBe(scrapedAt + 15_000)
			const windowed = yield* service.listChecks(orgId, target.id, {
				startTime: scrapedAt - 1,
				endTime: scrapedAt + 1,
			})
			expect(windowed).toHaveLength(1)
			expect(windowed[0]?.checkedAt.getTime()).toBe(scrapedAt)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("manual probes update the target but record no check rows", () => {
		const testDb = createTestDb(trackedDbs)
		globalThis.fetch = (async () => new Response("up 1\n", { status: 200 })) as typeof fetch
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
			const probed = yield* service.probe(orgId, target.id)
			expect(probed.success).toBe(true)
			expect(probed.lastScrapeAt).not.toBeNull()

			const checks = yield* service.listChecks(orgId, target.id, {})
			expect(checks).toHaveLength(0)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("prunes check rows older than the 24h retention window", () => {
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

			const checks = yield* service.listChecks(orgId, target.id, {})
			expect(checks).toHaveLength(1)
			expect(checks[0]?.checkedAt.getTime()).toBe(now - 60 * 60 * 1000)
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

			const result = yield* service.listChecks(asOrgId("org_2"), target.id, {}).pipe(Effect.exit)
			expect(Exit.isFailure(result)).toBe(true)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
