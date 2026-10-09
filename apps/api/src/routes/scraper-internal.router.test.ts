import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, Ref, Schema } from "effect"
import { HttpRouter } from "effect/http"
import {
	IngestKeysResponse,
	InternalScrapeTarget,
	IsoDateTimeString,
	OrgId,
	ScrapeTargetId,
} from "@maple/domain/http"
import type { ScrapeTargetRow } from "@maple/db/tables"
import { Env } from "@maple/backend/platform/Env"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { PlanetScaleDiscoveryService } from "@maple/backend/services/integrations/PlanetScaleDiscoveryService"
import { ScrapeTargetsService } from "@maple/backend/services/integrations/ScrapeTargetsService"
import { ScraperInternalRouter } from "./scraper-internal.http"

const die = () => Effect.die(new Error("not used by the scraper target list"))
const asOrgId = Schema.decodeUnknownSync(OrgId)
const asTargetId = Schema.decodeUnknownSync(ScrapeTargetId)
const asIso = Schema.decodeUnknownSync(IsoDateTimeString)
const decodeTargets = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(InternalScrapeTarget)))

const makeRow = (index: number): ScrapeTargetRow => ({
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
	createdAt: 0,
	updatedAt: 0,
})

const makeHarness = Effect.fnUntraced(function* (rowCount: number) {
	const rows = Array.from({ length: rowCount }, (_, index) => makeRow(index))
	const inFlight = yield* Ref.make(0)
	const maxInFlight = yield* Ref.make(0)
	const keyBatches = yield* Ref.make(0)
	const discovery = PlanetScaleDiscoveryService.of({
		discover: (row) =>
			Ref.updateAndGet(inFlight, (count) => count + 1).pipe(
				Effect.flatMap((current) => Ref.update(maxInFlight, (max) => Math.max(max, current))),
				Effect.andThen(Effect.sleep("20 millis")),
				Effect.ensuring(Ref.update(inFlight, (count) => count - 1)),
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
					Ref.update(keyBatches, (count) => count + 1).pipe(
						Effect.as(
							new Map(
								orgIds.map((orgId) => [
									orgId,
									new IngestKeysResponse({
										publicKey: `maple_pk_${orgId}`,
										privateKey: "maple_sk_unused",
										publicRotatedAt: asIso("2026-01-01T00:00:00.000Z"),
										privateRotatedAt: asIso("2026-01-01T00:00:00.000Z"),
									}),
								]),
							),
						),
					),
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
	yield* Effect.addFinalizer(() => Effect.promise(dispose))
	const listTargets = Effect.gen(function* () {
		const response = yield* Effect.promise(() =>
			handler(
				new Request("http://api.localhost/api/internal/scrape-targets", {
					headers: { authorization: "Bearer sd-token" },
				}),
				Context.empty(),
			),
		)
		const body = yield* Effect.promise(() => response.text()).pipe(Effect.flatMap(decodeTargets))
		return { status: response.status, body }
	})
	return { rows, maxInFlight, keyBatches, listTargets }
})

describe("GET /api/internal/scrape-targets", () => {
	it.live("discovers PlanetScale rows concurrently, bounded, and keeps row order", () =>
		Effect.gen(function* () {
			const harness = yield* makeHarness(9)
			const response = yield* harness.listTargets

			assert.strictEqual(response.status, 200)
			assert.strictEqual(yield* Ref.get(harness.maxInFlight), 4)
			assert.strictEqual(yield* Ref.get(harness.keyBatches), 1)
			assert.deepStrictEqual(
				response.body.map((target) => target.id),
				harness.rows.map((row) => row.id),
			)
			assert.strictEqual(response.body[1]?.ingestKey, "maple_pk_org_1")
		}),
	)
})
