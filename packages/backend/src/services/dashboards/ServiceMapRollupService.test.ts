import { afterEach, assert, describe, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgClickHouseSettings, OrgIngestKeys } from "@maple/db/tables"
import { OrgId } from "@maple/domain/http"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
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

const seedOrgs = (testDb: TestDb) =>
	Effect.gen(function* () {
		const database = yield* Database.pipe(Effect.provide(testDb.layer))
		yield* database.execute((db) =>
			Effect.gen(function* () {
				yield* db.run(
					PG.insertInto(OrgIngestKeys).values(
						[MANAGED_ORG, BYO_ORG].map((orgId) => ({
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
					),
				)
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
							Layer.mergeAll(testDb.layer, Layer.succeed(WarehouseQueryService, warehouse)),
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
})
