import { afterEach, describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { CreateScrapeTargetRequest, OrgId, ScrapeIntervalSeconds, ScrapeTargetId } from "@maple/domain/http"
import { DatabaseLibsqlLive } from "../lib/DatabaseLibsqlLive"
import { Env } from "../lib/Env"
import { cleanupTempDirs, createTempDbUrl as makeTempDb } from "../lib/test-sqlite"
import { ScrapeTargetsService } from "./ScrapeTargetsService"

const createdTempDirs: string[] = []
const originalFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = originalFetch
	cleanupTempDirs(createdTempDirs)
})

const createTempDbUrl = () => makeTempDb("maple-scrape-targets-", createdTempDirs)

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

const makeLayer = (url: string) =>
	ScrapeTargetsService.layer.pipe(
		Layer.provide(DatabaseLibsqlLive),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(url)),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asScrapeIntervalSeconds = Schema.decodeUnknownSync(ScrapeIntervalSeconds)

describe("ScrapeTargetsService", () => {
	it.effect("scrapeForCollector applies stored bearer credentials", () => {
		const { url } = createTempDbUrl()
		const calls: Array<{ url: string; authorization: string | null }> = []

		globalThis.fetch = (async (input, init) => {
			const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
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
		}).pipe(Effect.provide(makeLayer(url)))
	})

	it.effect("recordScrapeResults updates lastScrapeAt on success and clears the error", () => {
		const { url } = createTempDbUrl()
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
		}).pipe(Effect.provide(makeLayer(url)))
	})

	it.effect("recordScrapeResults keeps lastScrapeAt at the last good scrape on failure", () => {
		const { url } = createTempDbUrl()
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
			yield* service.recordScrapeResults([{ targetId: target.id, scrapedAt: goodScrapeAt, error: null }])
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
		}).pipe(Effect.provide(makeLayer(url)))
	})

	it.effect("recordScrapeResults tolerates unknown target ids and processes batches", () => {
		const { url } = createTempDbUrl()
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
		}).pipe(Effect.provide(makeLayer(url)))
	})
})
