// SAFETY-FILE: JSON in this test is emitted by the route under test before its fields are asserted.
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { IngestKeysResponse, IsoDateTimeString, OrgId, ScrapeTargetId } from "@maple/domain/http"
import type { scrapeTargets } from "@maple/db"
import { Env } from "@maple/backend/platform/Env"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { PlanetScaleDiscoveryService } from "@maple/backend/services/integrations/PlanetScaleDiscoveryService"
import { ScrapeTargetsService } from "@maple/backend/services/integrations/ScrapeTargetsService"
import { ScraperInternalRouter } from "./scraper-internal.http"

const die = () => Effect.die(new Error("not used by the scraper target list"))
const asOrgId = Schema.decodeUnknownSync(OrgId)
const asTargetId = Schema.decodeUnknownSync(ScrapeTargetId)
const asIso = Schema.decodeUnknownSync(IsoDateTimeString)

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(disposers.splice(0).map((dispose) => dispose()))
})

const makeRow = (index: number): typeof scrapeTargets.$inferSelect => ({
	id: asTargetId(`00000000-0000-4000-8000-00000000000${index}`),
	orgId: asOrgId(`org_${index % 2}`),
	name: `PlanetScale ${index}`,
	serviceName: null,
	url: "https://api.planetscale.com/v1/organizations/acme/metrics",
	targetType: "planetscale",
	discoveryConfigJson: null,
	scrapeIntervalSeconds: 60,
	labelsJson: null,
	authType: "planetscale_oauth",
	managedBy: null,
	authCredentialsCiphertext: null,
	authCredentialsIv: null,
	authCredentialsTag: null,
	enabled: true,
	lastScrapeAt: null,
	lastScrapeError: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
})

const makeHarness = (rowCount: number) => {
	const rows = Array.from({ length: rowCount }, (_, index) => makeRow(index))
	const stats = { inFlight: 0, maxInFlight: 0, keyBatches: 0 }
	const discovery = PlanetScaleDiscoveryService.of({
		discover: (row) =>
			Effect.sync(() => {
				stats.inFlight += 1
				stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
			}).pipe(
				Effect.andThen(Effect.sleep("20 millis")),
				Effect.ensuring(Effect.sync(() => (stats.inFlight -= 1))),
				Effect.as([
					{
						url: `https://${row.id}.psdb.cloud/metrics`,
						signedUrl: `https://${row.id}.psdb.cloud/metrics?sig=s`,
						subTargetKey: `branch-${row.id}`,
						labels: {},
					},
				]),
			),
		lastError: () => Effect.succeed(null),
		invalidate: () => Effect.void,
	})
	const layer = ScraperInternalRouter.pipe(
		Layer.provide(Layer.succeed(PlanetScaleDiscoveryService, discovery)),
		Layer.provide(
			Layer.succeed(ScrapeTargetsService, {
				list: die,
				get: die,
				create: die,
				update: die,
				delete: die,
				deleteManaged: die,
				listAllEnabled: () => Effect.succeed(rows),
				authHeaders: die,
				recordScrapeResults: die,
				listChecks: die,
				probe: die,
			}),
		),
		Layer.provide(
			Layer.succeed(OrgIngestKeysService, {
				getOrCreate: die,
				getOrCreateMany: (orgIds) =>
					Effect.sync(() => {
						stats.keyBatches += 1
						return new Map(
							orgIds.map((orgId) => [
								orgId,
								new IngestKeysResponse({
									publicKey: `maple_pk_${orgId}`,
									privateKey: "maple_sk_unused",
									publicRotatedAt: asIso("2026-01-01T00:00:00.000Z"),
									privateRotatedAt: asIso("2026-01-01T00:00:00.000Z"),
								}),
							]),
						)
					}),
				rerollPublic: die,
				rerollPrivate: die,
				resolveIngestKey: die,
			}),
		),
		Layer.provide(Env.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PORT: "3472",
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
					SD_INTERNAL_TOKEN: "sd-token",
				}),
			),
		),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(layer, { disableLogger: true })
	disposers.push(dispose)
	const listTargets = async () => {
		const response = await handler(
			new Request("http://api.localhost/api/internal/scrape-targets", {
				headers: { authorization: "Bearer sd-token" },
			}),
			Context.empty(),
		)
		return {
			status: response.status,
			body: JSON.parse(await response.text()) as Array<Record<string, unknown>>,
		}
	}
	return { rows, stats, listTargets }
}

describe("GET /api/internal/scrape-targets", () => {
	it("discovers PlanetScale rows concurrently, bounded, and keeps row order", async () => {
		const harness = makeHarness(9)
		const response = await harness.listTargets()

		assert.strictEqual(response.status, 200)
		assert.strictEqual(harness.stats.maxInFlight, 4)
		assert.strictEqual(harness.stats.keyBatches, 1)
		assert.deepStrictEqual(
			response.body.map((target) => target.id),
			harness.rows.map((row) => row.id),
		)
		assert.strictEqual(response.body[1]?.ingestKey, "maple_pk_org_1")
	})
})
