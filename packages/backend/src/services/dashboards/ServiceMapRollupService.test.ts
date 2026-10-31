import { afterEach, assert, describe, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgClickHouseSettings, OrgIngestKeys } from "@maple/db/tables"
import { OrgId } from "@maple/domain/http"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { EdgeCacheService, makeEdgeCacheService, makeMemoryBackend } from "@maple/cache"
import { Env } from "@maple/backend/platform/Env"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { configResolvingWarehouse, makeOrgConfigProbe } from "@maple/backend/testing/org-config-probe"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { ServiceMapRollupService } from "./ServiceMapRollupService"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const rowOrgId = (row: unknown) =>
	Schema.decodeUnknownSync(Schema.Struct({ OrgId: Schema.String }))(row).OrgId

const MANAGED_ORG = asOrgId("org_rollup_managed")
const BYO_ORG = asOrgId("org_rollup_byo")
const FOREIGN_ORG = asOrgId("org_rollup_foreign")

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const edgeRow = (orgId: OrgId) => ({
	OrgId: orgId,
	Hour: "2026-10-22 10:00:00",
	SourceService: "checkout",
	TargetService: "payments",
	DeploymentEnv: "production",
	CallCount: 3,
	ErrorCount: 0,
	DurationSumMs: 30,
	MaxDurationMs: 12,
	SampledSpanCount: 0,
	UnsampledSpanCount: 3,
	SampleRateSum: 3,
})

const configLive = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		TINYBIRD_HOST: "https://maple-managed.tinybird.co",
		TINYBIRD_TOKEN: "managed-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
	}),
)
const envLive = Env.layer.pipe(Layer.provide(configLive))

const insertIngestKeys = (orgIds: ReadonlyArray<OrgId>) =>
	PG.insertInto(OrgIngestKeys).values(
		orgIds.map((orgId) => ({
			orgId,
			publicKey: `pk_${orgId}`,
			publicKeyHash: `pkh_${orgId}`,
			privateKeyCiphertext: "ct",
			privateKeyIv: "iv",
			privateKeyTag: "tag",
			privateKeyHash: `prh_${orgId}`,
			publicRotatedAt: 0,
			privateRotatedAt: 0,
			createdAt: 0,
			updatedAt: 0,
			createdBy: "test",
			updatedBy: "test",
		})),
	)

const seedOrgs = (testDb: TestDb) =>
	Effect.gen(function* () {
		const database = yield* Database.pipe(Effect.provide(testDb.layer))
		yield* database.execute((db) =>
			Effect.gen(function* () {
				yield* db.run(insertIngestKeys([MANAGED_ORG, BYO_ORG]))
				yield* db.run(
					PG.insertInto(OrgClickHouseSettings).values({
						orgId: BYO_ORG,
						chUrl: "https://ch.example",
						chUser: "default",
						chDatabase: "maple",
						syncStatus: "connected",
						createdAt: 0,
						updatedAt: 0,
						createdBy: "test",
						updatedBy: "test",
					}),
				)
			}),
		)
	})

describe("ServiceMapRollupService", () => {
	it.effect("never writes managed rollup rows for an org whose reads route to its own ClickHouse", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(createdDbs)
			yield* seedOrgs(testDb)

			const ingested: Array<{ readonly orgId: OrgId; readonly rowOrgIds: ReadonlyArray<string> }> = []
			// A BYO org's rollup reads its own cluster, so its rows are whatever that
			// cluster returns, including a foreign OrgId.
			const warehouse = makeWarehouseServiceStub({
				crossOrgQuery: (_tenant, compiled) =>
					compiledQueryOf(compiled)
						.decodeRows([{ orgId: MANAGED_ORG }, { orgId: BYO_ORG }])
						.pipe(Effect.orDie),
				compiledQuery: (tenant, compiled, options) =>
					compiledQueryOf(compiled)
						.decodeRows(
							options?.context === "serviceMapRollup"
								? [edgeRow(tenant.orgId === BYO_ORG ? FOREIGN_ORG : tenant.orgId)]
								: [],
						)
						.pipe(Effect.orDie),
				ingest: (tenant, _datasource, rows) =>
					Effect.sync(
						() => void ingested.push({ orgId: tenant.orgId, rowOrgIds: rows.map(rowOrgId) }),
					),
			})

			const result = yield* ServiceMapRollupService.use((service) => service.runRollupTick()).pipe(
				Effect.provide(
					Layer.effect(ServiceMapRollupService, ServiceMapRollupService.make).pipe(
						Layer.provide(
							Layer.mergeAll(
								Layer.succeed(WarehouseQueryService, warehouse),
								OrgClickHouseSettingsService.layer,
							),
						),
						Layer.provide(
							Layer.mergeAll(
								testDb.layer,
								envLive,
								Layer.succeed(EdgeCacheService, makeEdgeCacheService(makeMemoryBackend())),
							),
						),
					),
				),
			)

			const writtenOrgs = new Set(ingested.flatMap((write) => write.rowOrgIds))
			assert.deepStrictEqual([...writtenOrgs], [MANAGED_ORG])
			assert.deepStrictEqual([...new Set(ingested.map((write) => write.orgId))], [MANAGED_ORG])
			assert.strictEqual(result.orgsProcessed, 1)
			assert.strictEqual(result.orgFailures, 0)
		}),
	)

	// Fresh org ids per run: the runtime-config memo is module-scoped.
	const runId = Math.random().toString(36).slice(2, 10)
	it.effect("resolves every target org's warehouse config in one batched read", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(createdDbs)
			// More orgs than the tick's per-org concurrency (4).
			const orgs = Array.from({ length: 6 }, (_, i) => asOrgId(`org_rollup_prime_${runId}_${i}`))
			const database = yield* Database.pipe(Effect.provide(testDb.layer))
			yield* database.execute((db) => db.run(insertIngestKeys(orgs)))

			const probe = yield* makeOrgConfigProbe
			const warehouse = configResolvingWarehouse((resolveConfig) =>
				makeWarehouseServiceStub({
					crossOrgQuery: (tenant, compiled) =>
						Effect.andThen(
							resolveConfig(tenant.orgId),
							compiledQueryOf(compiled)
								.decodeRows(orgs.map((orgId) => ({ orgId })))
								.pipe(Effect.orDie),
						),
					compiledQuery: (tenant, compiled) =>
						Effect.andThen(
							resolveConfig(tenant.orgId),
							compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
						),
				}),
			)

			const result = yield* ServiceMapRollupService.use((service) => service.runRollupTick()).pipe(
				Effect.provide(
					Layer.effect(ServiceMapRollupService, ServiceMapRollupService.make).pipe(
						Layer.provide(warehouse),
						Layer.provideMerge(probe.orgChSettingsLive),
						Layer.provide(Layer.mergeAll(testDb.layer, envLive, probe.edgeCacheLive)),
					),
				),
			)

			assert.strictEqual(result.orgsProcessed, orgs.length)
			assert.strictEqual(result.orgFailures, 0)
			// Only the active-org discovery route resolves cold, before the org set is
			// known. Without the prime, every target org does its own cold read.
			assert.strictEqual(yield* probe.coldReads, 1)
		}),
	)
})
