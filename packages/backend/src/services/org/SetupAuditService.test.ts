import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { OrgId, UserId } from "@maple/domain/http"
import { compiledQueryOf } from "@maple/query-engine/execution"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { IntegrationInventoryService } from "@maple/backend/services/integrations/IntegrationInventoryService"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { SetupAuditService } from "@maple/backend/services/org/SetupAuditService"
import { SignalPresenceService } from "@maple/backend/services/org/SignalPresenceService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_setup_audit")
const USER = Schema.decodeUnknownSync(UserId)("user_setup_audit")
const tenant: TenantContext = { orgId: ORG, userId: USER, roles: ["org:admin"], authMode: "self_hosted" }

const signalPresence = (tracesStatus: "present" | "absent") =>
	Layer.succeed(SignalPresenceService, {
		read: () =>
			Effect.succeed({
				generatedAt: 0,
				windowStart: 0,
				windowEnd: 0,
				warehouseAvailable: true,
				signals: [
					{ signal: "traces", status: tracesStatus, count: 1, firstSeen: null, lastSeen: null },
					{ signal: "sessions", status: "present", count: 1, firstSeen: null, lastSeen: null },
				],
			}),
	})

const warehouse = Layer.succeed(
	WarehouseQueryService,
	makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
	}),
)

const makeLayer = (testDb: TestDb, tracesStatus: "present" | "absent") =>
	Layer.effect(SetupAuditService, SetupAuditService.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				warehouse,
				signalPresence(tracesStatus),
				OnboardingService.layer,
				IntegrationInventoryService.layer,
			),
		),
		Layer.provideMerge(testDb.layer),
	)

const firstDataInDb = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ first_data_received_at: Date | null }>(
			testDb,
			`SELECT first_data_received_at FROM org_onboarding_state WHERE org_id = $1`,
			[ORG],
		),
	)

const seedUnstampedRow = (testDb: TestDb) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO org_onboarding_state (org_id, demo_data_requested, created_at, updated_at)
			 VALUES ($1, false, now(), now())`,
			[ORG],
		),
	)

describe("SetupAuditService first-data stamping", () => {
	it.effect("runs the audit and stamps the row when an unstamped org has telemetry", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seedUnstampedRow(testDb)
			const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
			assert.strictEqual(report.dataStatus, "ok")
			assert.isAbove(report.checks.length, 0)
			const row = yield* firstDataInDb(testDb)
			assert.isNotNull(row?.first_data_received_at ?? null)
		}).pipe(Effect.provide(makeLayer(testDb, "present")))
	})

	it.effect("creates and stamps the row when the org has no onboarding state at all", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
			assert.strictEqual(report.dataStatus, "ok")
			const row = yield* firstDataInDb(testDb)
			assert.isNotNull(row?.first_data_received_at ?? null)
		}).pipe(Effect.provide(makeLayer(testDb, "present")))
	})

	it.effect("keeps no_data and leaves the row unstamped when the org has no telemetry", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seedUnstampedRow(testDb)
			const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
			assert.strictEqual(report.dataStatus, "no_data")
			assert.strictEqual(report.checks.length, 0)
			const row = yield* firstDataInDb(testDb)
			assert.isNull(row?.first_data_received_at ?? null)
		}).pipe(Effect.provide(makeLayer(testDb, "absent")))
	})
})
