import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import { AlertDestinationId, AlertIncidentId, AlertRuleId, OrgId } from "@maple/domain/http"
import { Effect, Layer, Schema, Array as Arr } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceApi,
} from "@maple/backend/services/warehouse/WarehouseQueryService"
import { AlertReadModelsService } from "./AlertReadModelsService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"

// Compile-time guard: scheduler, delivery, Env, cache, and query-engine
// capabilities cannot enter this layer without making the assignment fail.
const readModelRequirements: Layer.Layer<AlertReadModelsService, never, Database | WarehouseQueryService> =
	Layer.effect(AlertReadModelsService, AlertReadModelsService.make)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asRuleId = Schema.decodeUnknownSync(AlertRuleId)
const asIncidentId = Schema.decodeUnknownSync(AlertIncidentId)
const asDestinationId = Schema.decodeUnknownSync(AlertDestinationId)

const ORG = asOrgId("org_alert_read_models")
const OTHER_ORG = asOrgId("org_alert_read_models_other")
const RULE = asRuleId("00000000-0000-4000-8000-000000000010")
const INCIDENT_OLD = asIncidentId("00000000-0000-4000-8000-000000000011")
const INCIDENT_NEW = asIncidentId("00000000-0000-4000-8000-000000000012")
const DESTINATION = asDestinationId("00000000-0000-4000-8000-000000000013")
const DELIVERY = "00000000-0000-4000-8000-000000000014"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const makeWarehouseStub = (contexts: Array<string>): WarehouseQueryServiceApi =>
	makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled, options) =>
			Effect.sync(() => contexts.push(options?.context ?? "")).pipe(
				Effect.andThen(compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie)),
			),
	})

const makeLayer = (testDb: TestDb, contexts: Array<string>) =>
	readModelRequirements.pipe(
		Layer.provide(
			Layer.mergeAll(testDb.layer, Layer.succeed(WarehouseQueryService, makeWarehouseStub(contexts))),
		),
	)

const seedReadModels = async (testDb: TestDb) => {
	const created = new Date("2026-08-01T10:00:00.000Z")
	await executeSql(
		testDb,
		`INSERT INTO alert_destinations
		   (id, org_id, name, type, enabled, config_json, secret_ciphertext, secret_iv, secret_tag,
		    created_at, updated_at, created_by, updated_by)
		 VALUES ($1, $2, 'Primary webhook', 'webhook', true, '{}'::jsonb, '', '', '',
		         $3, $3, 'user_read_models', 'user_read_models')`,
		[DESTINATION, ORG, created],
	)
	await executeSql(
		testDb,
		`INSERT INTO alert_rules
		   (id, org_id, name, enabled, severity, signal_type, comparator, threshold, window_minutes,
		    destination_ids_json, reducer, no_data_behavior, created_at, updated_at, created_by, updated_by)
		 VALUES ($1, $2, 'Read model rule', true, 'warning', 'error_rate', 'gt', 5, 5,
		         '[]'::jsonb, 'avg', 'skip', $3, $3, 'user_read_models', 'user_read_models')`,
		[RULE, ORG, created],
	)
	await executeSql(
		testDb,
		`INSERT INTO alert_incidents
		   (id, org_id, rule_id, incident_key, rule_name, group_key, signal_type, severity, status,
		    comparator, threshold, first_triggered_at, last_triggered_at, resolved_at,
		    last_observed_value, last_sample_count, dedupe_key, created_at, updated_at)
		 VALUES
		   ($1, $3, $4, 'read-old', 'Read model rule', 'api', 'error_rate', 'warning', 'resolved',
		    'gt', 5, '2026-08-01T10:00:00Z', '2026-08-01T10:05:00Z', '2026-08-01T10:06:00Z',
		    7, 20, 'dedupe-old', $5, $5),
		   ($2, $3, $4, 'read-new', 'Read model rule', 'worker', 'error_rate', 'critical', 'open',
		    'gt', 5, '2026-08-01T10:10:00Z', '2026-08-01T10:15:00Z', null,
		    9, 30, 'dedupe-new', $5, $5)`,
		[INCIDENT_OLD, INCIDENT_NEW, ORG, RULE, created],
	)
	await executeSql(
		testDb,
		`INSERT INTO alert_delivery_events
		   (id, org_id, incident_id, rule_id, destination_id, delivery_key, event_type,
		    attempt_number, status, scheduled_at, attempted_at, response_code, payload_json,
		    created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, 'delivery-read-model', 'trigger', 1, 'success',
		         '2026-08-01T10:16:00Z', '2026-08-01T10:16:01Z', 204, '{}'::jsonb,
		         '2026-08-01T10:16:00Z', '2026-08-01T10:16:01Z')`,
		[DELIVERY, ORG, INCIDENT_NEW, RULE, DESTINATION],
	)
}

describe("AlertReadModelsService", () => {
	it.effect("reads incident and delivery projections without the scheduler graph", () => {
		const testDb = createTestDb(createdDbs)
		const contexts: Array<string> = []
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedReadModels(testDb))
			const readModels = yield* AlertReadModelsService

			const incidents = yield* readModels.listIncidents(ORG)
			assert.deepStrictEqual(
				Arr.map(incidents.incidents, (incident) => incident.id),
				[INCIDENT_NEW, INCIDENT_OLD],
			)
			const open = yield* readModels.listIncidents(ORG, { status: "open", limit: 1 })
			assert.deepStrictEqual(
				Arr.map(open.incidents, (incident) => incident.id),
				[INCIDENT_NEW],
			)
			assert.strictEqual((yield* readModels.getIncident(ORG, INCIDENT_NEW)).groupKey, "worker")

			const deliveries = yield* readModels.listDeliveryEvents(ORG)
			assert.strictEqual(deliveries.events[0]?.id, DELIVERY)
			assert.strictEqual(deliveries.events[0]?.destinationName, "Primary webhook")
			assert.strictEqual(deliveries.events[0]?.responseCode, 204)

			// The incident filter is what the mobile incident timeline reads.
			const forNew = yield* readModels.listDeliveryEvents(ORG, { incidentId: INCIDENT_NEW })
			assert.deepStrictEqual(
				Arr.map(forNew.events, (event) => event.id),
				[DELIVERY],
			)
			const forOld = yield* readModels.listDeliveryEvents(ORG, { incidentId: INCIDENT_OLD })
			assert.deepStrictEqual(forOld.events, [])
			const forRule = yield* readModels.listDeliveryEvents(ORG, { ruleId: RULE })
			assert.strictEqual(forRule.events.length, 1)
			assert.deepStrictEqual(contexts, [])
		}).pipe(Effect.provide(makeLayer(testDb, contexts)))
	})

	it.effect("reads an unbounded check-history page in widening windows from its cursor", () => {
		const testDb = createTestDb(createdDbs)
		const sqls: Array<string> = []
		const stub = makeWarehouseServiceStub({
			compiledQuery: (_tenant, compiled) => {
				const query = compiledQueryOf(compiled)
				return Effect.sync(() => sqls.push(query.sql)).pipe(
					Effect.andThen(query.decodeRows([]).pipe(Effect.orDie)),
				)
			},
		})
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedReadModels(testDb))
			const readModels = yield* AlertReadModelsService

			yield* readModels.listRuleChecks(ORG, RULE, {
				limit: 20,
				beforeTimestamp: "2026-08-10T00:00:00.000Z",
				beforeGroupKey: "api",
			})
			// 7 days back from the cursor; the empty page widens, but never before the rule's creation.
			expect(sqls).toHaveLength(2)
			expect(sqls[0]).toContain("Timestamp >= '2026-08-03 00:00:00")
			expect(sqls[1]).toContain("Timestamp >= '2026-08-01 10:00:00")

			yield* readModels.listRuleChecks(ORG, RULE, { limit: 20, since: "2026-07-01T00:00:00.000Z" })
			expect(sqls).toHaveLength(3)
			expect(sqls[2]).toContain("Timestamp >= '2026-07-01 00:00:00")
		}).pipe(
			Effect.provide(
				readModelRequirements.pipe(
					Layer.provide(Layer.mergeAll(testDb.layer, Layer.succeed(WarehouseQueryService, stub))),
				),
			),
		)
	})

	it.effect("stops widening once a check-history page fills", () => {
		const testDb = createTestDb(createdDbs)
		const sqls: Array<string> = []
		const check = (minute: number) => ({
			timestamp: `2026-08-09 10:0${minute}:00.000`,
			windowStart: "2026-08-09 09:55:00.000",
			windowEnd: "2026-08-09 10:00:00.000",
			groupKey: "",
			status: "healthy",
			signalType: "error_rate",
			comparator: "gt",
			threshold: 1,
			observedValue: null,
			sampleCount: 0,
			windowMinutes: 5,
			consecutiveBreaches: 0,
			consecutiveHealthy: 1,
			incidentId: null,
			incidentTransition: "none",
			evaluationDurationMs: 3,
			errorMessage: null,
			errorCategory: "",
			skipReason: "",
			level: "",
		})
		const stub = makeWarehouseServiceStub({
			compiledQuery: (_tenant, compiled) => {
				const query = compiledQueryOf(compiled)
				return Effect.sync(() => sqls.push(query.sql)).pipe(
					Effect.andThen(query.decodeRows([check(1), check(2)]).pipe(Effect.orDie)),
				)
			},
		})
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedReadModels(testDb))
			const readModels = yield* AlertReadModelsService

			const page = yield* readModels.listRuleChecks(ORG, RULE, {
				limit: 2,
				beforeTimestamp: "2026-08-10T00:00:00.000Z",
				beforeGroupKey: "api",
			})
			// The 7-day read already filled the page, so no wider window is read.
			expect(sqls).toHaveLength(1)
			expect(page.checks).toHaveLength(2)
		}).pipe(
			Effect.provide(
				readModelRequirements.pipe(
					Layer.provide(Layer.mergeAll(testDb.layer, Layer.succeed(WarehouseQueryService, stub))),
				),
			),
		)
	})

	it.effect("enforces org ownership before warehouse-backed check reads", () => {
		const testDb = createTestDb(createdDbs)
		const contexts: Array<string> = []
		return Effect.gen(function* () {
			yield* Effect.promise(() => seedReadModels(testDb))
			const readModels = yield* AlertReadModelsService

			const missingIncident = yield* Effect.flip(readModels.getIncident(OTHER_ORG, INCIDENT_NEW))
			assert.strictEqual(missingIncident._tag, "@maple/http/errors/AlertIncidentNotFoundError")

			const missingChecks = yield* Effect.flip(readModels.listRuleChecks(OTHER_ORG, RULE, {}))
			assert.strictEqual(missingChecks._tag, "@maple/http/errors/AlertRuleNotFoundError")
			assert.deepStrictEqual(contexts, [])

			const checks = yield* readModels.listRuleChecks(ORG, RULE, { limit: 20 })
			assert.deepStrictEqual(checks.checks, [])
			const summary = yield* readModels.summarizeRuleChecks(ORG, RULE, {
				since: "2026-08-01T00:00:00.000Z",
				until: "2026-08-02T00:00:00.000Z",
			})
			expect(summary).toMatchObject({
				topGroupKeys: [],
				points: [],
				totals: { total: 0, breached: 0, healthy: 0, skipped: 0, error: 0, transitions: 0 },
			})
		}).pipe(Effect.provide(makeLayer(testDb, contexts)))
	})
})
