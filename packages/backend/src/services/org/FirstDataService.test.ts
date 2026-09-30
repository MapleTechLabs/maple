import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { compiledQueryOf } from "@maple/query-engine/execution"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { FirstDataService } from "@maple/backend/services/org/FirstDataService"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const decodeOrgId = Schema.decodeUnknownSync(OrgId)
const SENDING = decodeOrgId("org_sending")
const NO_ROW = decodeOrgId("org_sending_no_row")
const SELF_HOSTED = decodeOrgId("org_sending_self_hosted")
const IDLE = decodeOrgId("org_idle")
const STAMPED = decodeOrgId("org_already_stamped")
const ORG_CREATED_AT = Date.UTC(2026, 8, 1)
const STAMPED_AT = new Date(Date.UTC(2026, 7, 1))

/** Active orgs come back from the traces scan only; the logs scan is empty. */
const warehouse = (activeOrgs: ReadonlyArray<OrgId>) =>
	makeWarehouseServiceStub({
		crossOrgQuery: (_tenant, compiled) =>
			compiledQueryOf(compiled)
				.decodeRows(
					compiledQueryOf(compiled).sql.includes("FROM traces_aggregates_hourly")
						? activeOrgs.map((orgId) => ({ orgId }))
						: [],
				)
				.pipe(Effect.orDie),
	})

const organizations = Layer.succeed(OrganizationService, {
	retrieve: (orgId) =>
		Effect.succeed({
			id: orgId,
			name: null,
			slug: null,
			imageUrl: null,
			createdAtMs: orgId === SELF_HOSTED ? null : ORG_CREATED_AT,
		}),
	delete: () => Effect.die(new Error("not exercised by this test")),
})

const makeLayer = (testDb: TestDb, activeOrgs: ReadonlyArray<OrgId>) =>
	Layer.effect(FirstDataService, FirstDataService.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(WarehouseQueryService, warehouse(activeOrgs)),
				OnboardingService.layer,
				organizations,
			),
		),
		Layer.provideMerge(testDb.layer),
	)

const seedIngestKey = (testDb: TestDb, orgId: OrgId) =>
	executeSql(
		testDb,
		`INSERT INTO org_ingest_keys
		   (org_id, public_key, public_key_hash, private_key_ciphertext, private_key_iv, private_key_tag,
		    private_key_hash, public_rotated_at, private_rotated_at, created_at, updated_at, created_by, updated_by)
		 VALUES ($1, $1 || '_pk', $1 || '_pkh', '', '', '', $1 || '_skh', now(), now(), now(), now(), 'u', 'u')`,
		[orgId],
	)

const seedOnboardingRow = (testDb: TestDb, orgId: OrgId, firstDataReceivedAt: Date | null) =>
	executeSql(
		testDb,
		`INSERT INTO org_onboarding_state (org_id, first_data_received_at, created_at, updated_at)
		 VALUES ($1, $2, now(), now())`,
		[orgId, firstDataReceivedAt],
	)

const onboardingRow = (testDb: TestDb, orgId: OrgId) =>
	queryFirstRow<{ first_data_received_at: Date | null; created_at: Date }>(
		testDb,
		`SELECT first_data_received_at, created_at FROM org_onboarding_state WHERE org_id = $1`,
		[orgId],
	)

describe("FirstDataService.runTick", () => {
	it.effect("stamps unstamped orgs that are sending, and only those", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const firstData = yield* FirstDataService
			yield* Effect.promise(async () => {
				for (const orgId of [SENDING, NO_ROW, SELF_HOSTED, IDLE, STAMPED]) {
					await seedIngestKey(testDb, orgId)
				}
				await seedOnboardingRow(testDb, SENDING, null)
				await seedOnboardingRow(testDb, IDLE, null)
				await seedOnboardingRow(testDb, STAMPED, STAMPED_AT)
			})

			const result = yield* firstData.runTick()
			assert.deepStrictEqual(result, { unstampedOrgs: 4, stamped: 2, orgFailures: 0 })

			const rows = yield* Effect.promise(() =>
				Promise.all(
					[SENDING, NO_ROW, SELF_HOSTED, IDLE, STAMPED].map((orgId) =>
						onboardingRow(testDb, orgId),
					),
				),
			)
			const [sending, noRow, selfHosted, idle, stamped] = rows
			assert.isNotNull(sending?.first_data_received_at)
			// A missing row is created with the org's creation time from the identity provider.
			assert.isNotNull(noRow?.first_data_received_at)
			assert.strictEqual(noRow?.created_at.getTime(), ORG_CREATED_AT)
			// No creation time to write, so no row, as the checklist does.
			assert.isUndefined(selfHosted)
			assert.isNull(idle?.first_data_received_at)
			assert.strictEqual(stamped?.first_data_received_at?.getTime(), STAMPED_AT.getTime())
		}).pipe(Effect.provide(makeLayer(testDb, [SENDING, NO_ROW, SELF_HOSTED, STAMPED])))
	})

	it.effect("skips the warehouse scan when every org is already stamped", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const firstData = yield* FirstDataService
			yield* Effect.promise(async () => {
				await seedIngestKey(testDb, STAMPED)
				await seedOnboardingRow(testDb, STAMPED, STAMPED_AT)
			})
			const result = yield* firstData.runTick()
			assert.deepStrictEqual(result, { unstampedOrgs: 0, stamped: 0, orgFailures: 0 })
		}).pipe(
			Effect.provide(
				Layer.effect(FirstDataService, FirstDataService.make).pipe(
					Layer.provide(
						Layer.mergeAll(
							// Any warehouse call fails this test.
							Layer.succeed(WarehouseQueryService, makeWarehouseServiceStub()),
							OnboardingService.layer,
							organizations,
						),
					),
					Layer.provideMerge(testDb.layer),
				),
			),
		)
	})
})
