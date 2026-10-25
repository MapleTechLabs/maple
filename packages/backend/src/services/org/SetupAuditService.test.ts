import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { OrgId, UserId } from "@maple/domain/http"
import { SETUP_AUDIT_CHECKS } from "@maple/domain/setup-audit"
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
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { SetupAuditService } from "@maple/backend/services/org/SetupAuditService"
import { SignalPresenceService } from "@maple/backend/services/org/SignalPresenceService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_setup_audit")
const USER = Schema.decodeUnknownSync(UserId)("user_setup_audit")
const tenant: TenantContext = { orgId: ORG, userId: USER, roles: ["org:admin"], authMode: "self_hosted" }

type Probe = "present" | "absent" | "unavailable"

const signalPresence = (probe: Probe) =>
	Layer.succeed(SignalPresenceService, {
		read: () =>
			Effect.succeed({
				generatedAt: 0,
				windowStart: 0,
				windowEnd: 0,
				warehouseAvailable: probe !== "unavailable",
				signals: [
					{
						signal: "traces",
						status: probe === "unavailable" ? "unknown" : probe,
						count: probe === "present" ? 1 : 0,
						firstSeen: null,
						lastSeen: null,
					},
					{
						signal: "sessions",
						status: probe === "unavailable" ? "unknown" : "present",
						count: 1,
						firstSeen: null,
						lastSeen: null,
					},
				],
			}),
	})

/** The SQL of each warehouse query the last audit ran, by its `context`. */
const sqlByContext = new Map<string, string>()

const warehouse = Layer.succeed(
	WarehouseQueryService,
	makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled, options) => {
			const query = compiledQueryOf(compiled)
			if (options?.context) sqlByContext.set(options.context, query.sql)
			return query.decodeRows([]).pipe(Effect.orDie)
		},
	}),
)

const ORG_CREATED_AT = Date.UTC(2025, 0, 1)

const organizations = Layer.succeed(OrganizationService, {
	retrieve: (orgId) =>
		Effect.succeed({ id: orgId, name: null, slug: null, imageUrl: null, createdAtMs: ORG_CREATED_AT }),
})

const makeLayer = (testDb: TestDb, probe: Probe) =>
	Layer.effect(SetupAuditService, SetupAuditService.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				warehouse,
				signalPresence(probe),
				OnboardingService.layer,
				organizations,
				IntegrationInventoryService.layer,
			),
		),
		Layer.provideMerge(testDb.layer),
	)

const firstDataInDb = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ first_data_received_at: Date | null; created_at: Date }>(
			testDb,
			`SELECT first_data_received_at, created_at FROM org_onboarding_state WHERE org_id = $1`,
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

	it.effect("creates the row dated by the org's creation time when the org has no onboarding state", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
			assert.strictEqual(report.dataStatus, "ok")
			const row = yield* firstDataInDb(testDb)
			assert.isNotNull(row?.first_data_received_at ?? null)
			assert.strictEqual(row?.created_at.getTime(), ORG_CREATED_AT)
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

	it.effect(
		"runs the config checks, skips telemetry checks, and leaves the row unstamped when the probe cannot read the warehouse",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* seedUnstampedRow(testDb)
				const report = yield* SetupAuditService.use((audit) => audit.run(tenant))
				assert.strictEqual(report.dataStatus, "ok")
				assert.isFalse(report.warehouseAvailable)
				const skipped = report.checks.filter((row) => row.status === "skip").map((row) => row.id)
				const needsWarehouse = SETUP_AUDIT_CHECKS.filter((row) => row.needsWarehouse === true)
				assert.deepStrictEqual(
					skipped,
					needsWarehouse.map((row) => row.id),
				)
				assert.isAbove(report.checks.length, skipped.length)
				const row = yield* firstDataInDb(testDb)
				assert.isNull(row?.first_data_received_at ?? null)
			}).pipe(Effect.provide(makeLayer(testDb, "unavailable")))
		},
	)
})

describe("SetupAuditService ingest sampling", () => {
	const seedSamplingPolicy = (testDb: TestDb, ratio: number) =>
		Effect.promise(() =>
			executeSql(
				testDb,
				`INSERT INTO org_ingest_sampling_policies (org_id, trace_sample_ratio, always_keep_error_spans, always_keep_slow_spans_ms)
				 VALUES ($1, $2, true, 2000)`,
				[ORG, ratio],
			),
		)

	const rootlessSql = (testDb: TestDb, ratio: number) =>
		Effect.gen(function* () {
			sqlByContext.clear()
			yield* seedSamplingPolicy(testDb, ratio)
			yield* SetupAuditService.use((audit) => audit.run(tenant))
			return sqlByContext.get("setupAuditRootlessTraces") ?? ""
		}).pipe(Effect.provide(makeLayer(testDb, "present")))

	it.effect("treats the spans the ingest sampler keeps as sampled when it drops traces", () =>
		Effect.gen(function* () {
			const sql = yield* rootlessSql(createTestDb(trackedDbs), 0.25)
			assert.include(sql, "traces.StatusCode = 'Error' OR traces.Duration >= 2000000000")
		}),
	)

	it.effect("ignores the keep rules when the ingest sampler keeps every trace", () =>
		Effect.gen(function* () {
			const sql = yield* rootlessSql(createTestDb(trackedDbs), 1)
			assert.include(sql, "unkeptSpans")
			assert.notInclude(sql, "Duration >=")
		}),
	)
})
