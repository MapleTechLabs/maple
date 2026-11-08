import { afterEach, assert, describe, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertIncidents, AlertRules, AnomalyIncidents } from "@maple/db/tables"
import {
	AlertIncidentId,
	AlertRuleId,
	AnomalyIncidentId,
	OrgId,
	UserId,
	type AlertThresholds,
	type AnomalyIncidentSeverity,
	type AnomalySignalType,
} from "@maple/domain/http"
import { Array as Arr, Effect, Layer, Order, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AnomalyAlertSource } from "./AnomalyAlertSource"
import {
	DEFAULT_ANOMALY_RULE_FALLBACK_NAME,
	DEFAULT_ANOMALY_RULE_NAME,
	defaultAnomalyRuleFields,
} from "./anomaly-rule"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asRuleId = Schema.decodeUnknownSync(AlertRuleId)
const asAnomalyId = Schema.decodeUnknownSync(AnomalyIncidentId)
const asAlertIncidentId = Schema.decodeUnknownSync(AlertIncidentId)
const asUserId = Schema.decodeUnknownSync(UserId)

const ORG = asOrgId("org_anomaly_source")
const QUIET_ORG = asOrgId("org_anomaly_source_quiet")
const USER = asUserId("user_anomaly_source")
const DEFAULT_RULE = asRuleId("00000000-0000-4000-8000-000000000301")
const CHECKOUT_RULE = asRuleId("00000000-0000-4000-8000-000000000302")
const NOW = Date.parse("2026-11-06T12:00:00.000Z")

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = (testDb: TestDb) => AnomalyAlertSource.layer.pipe(Layer.provide(testDb.layer))

const insertRule = (
	orgId: OrgId,
	id: AlertRuleId,
	name: string,
	scope: { readonly serviceNames?: ReadonlyArray<string>; readonly thresholds?: AlertThresholds } = {},
) =>
	Effect.gen(function* () {
		const database = yield* Database
		const fields = defaultAnomalyRuleFields(orgId, name)
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(AlertRules).values({
					...fields,
					id,
					serviceNamesJson: scope.serviceNames === undefined ? null : [...scope.serviceNames],
					thresholdsJson: scope.thresholds ?? fields.thresholdsJson,
					lastScheduledAt: null,
					createdAt: NOW,
					updatedAt: NOW,
					createdBy: USER,
					updatedBy: USER,
				}),
			),
		)
	})

const insertAnomaly = (fields: {
	readonly id: string
	readonly orgId?: OrgId
	readonly signalType: AnomalySignalType
	readonly serviceName: string
	readonly severity: AnomalyIncidentSeverity
	readonly status?: "open" | "resolved"
	readonly lastObservedValue: number
	readonly baselineMedian: number
}) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(AnomalyIncidents).values({
					id: asAnomalyId(fields.id),
					orgId: fields.orgId ?? ORG,
					detectorKey: `${fields.signalType}:production:${fields.serviceName}`,
					signalType: fields.signalType,
					serviceName: fields.serviceName,
					deploymentEnv: "production",
					fingerprintHash: null,
					errorIssueId: null,
					status: fields.status ?? "open",
					severity: fields.severity,
					openedValue: fields.lastObservedValue,
					baselineMedian: fields.baselineMedian,
					baselineSigma: 0.001,
					thresholdValue: fields.baselineMedian * 2,
					lastObservedValue: fields.lastObservedValue,
					firstTriggeredAt: NOW,
					lastTriggeredAt: NOW,
					resolvedAt: null,
					resolveReason: null,
					dedupeKey: `dedupe-${fields.id}`,
					createdAt: NOW,
					updatedAt: NOW,
				}),
			),
		)
	})

const insertOpenAlertIncident = (ruleId: AlertRuleId, groupKey: string) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(AlertIncidents).values({
					id: asAlertIncidentId("00000000-0000-4000-8000-000000000399"),
					orgId: ORG,
					ruleId,
					incidentKey: `incident-${groupKey}`,
					ruleName: "Anomaly detection",
					groupKey,
					signalType: "anomaly",
					severity: "warning",
					status: "open",
					comparator: "gte",
					threshold: 1,
					firstTriggeredAt: NOW,
					lastTriggeredAt: NOW,
					dedupeKey: `dedupe-${groupKey}`,
					createdAt: NOW,
					updatedAt: NOW,
				}),
			),
		)
	})

const byGroupKey = Order.mapInput(
	Order.String,
	(observation: { readonly groupKey: string }) => observation.groupKey,
)

const CHECKOUT_SPIKE = "00000000-0000-4000-8000-000000000311"
const API_DRIFT = "00000000-0000-4000-8000-000000000312"

const checkoutSpike = (severity: AnomalyIncidentSeverity = "critical") =>
	insertAnomaly({
		id: CHECKOUT_SPIKE,
		signalType: "error_rate",
		serviceName: "checkout",
		severity,
		lastObservedValue: 0.042,
		baselineMedian: 0.003,
	})

const disableRule = (ruleId: AlertRuleId) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.run(
				PG.update(AlertRules)
					.set({ enabled: false })
					.where(($) => [$.id.eq(ruleId)]),
			),
		)
	})

const observedKeys = (ruleId: AlertRuleId) =>
	Effect.gen(function* () {
		const source = yield* AnomalyAlertSource
		const observations = Arr.sort(yield* source.observe(ORG, ruleId), byGroupKey)
		return Arr.map(observations, (observation) => [observation.groupKey, observation.value])
	})

describe("AnomalyAlertSource.observe", () => {
	it.effect("emits the anomalies a rule is assigned, keyed by anomaly incident", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* insertRule(ORG, DEFAULT_RULE, DEFAULT_ANOMALY_RULE_NAME)
			yield* insertRule(ORG, CHECKOUT_RULE, "Checkout anomalies", { serviceNames: ["checkout"] })
			yield* checkoutSpike()
			yield* insertAnomaly({
				id: API_DRIFT,
				signalType: "latency_p95",
				serviceName: "api",
				severity: "warning",
				lastObservedValue: 840,
				baselineMedian: 210,
			})
			yield* insertAnomaly({
				id: "00000000-0000-4000-8000-000000000313",
				signalType: "throughput",
				serviceName: "api",
				severity: "critical",
				status: "resolved",
				lastObservedValue: 3,
				baselineMedian: 1200,
			})
			const source = yield* AnomalyAlertSource

			const checkout = yield* source.observe(ORG, CHECKOUT_RULE)
			assert.deepStrictEqual(checkout, [
				{
					groupKey: CHECKOUT_SPIKE,
					value: 2,
					detail: "error rate 4.2% vs baseline 0.3% in checkout (production)",
					anomalyIncidentId: asAnomalyId(CHECKOUT_SPIKE),
					errorIssueId: null,
					serviceName: "checkout",
					deploymentEnv: "production",
					signalType: "error_rate",
					groupLabel: "checkout (production)",
				},
			])

			// The default rule gets what no narrower rule covers, and never a resolved anomaly.
			assert.deepStrictEqual(yield* observedKeys(DEFAULT_RULE), [[API_DRIFT, 1]])
		}).pipe(Effect.provide(Layer.merge(makeLayer(testDb), testDb.layer)))
	})

	it.effect(
		"reports 0, with the anomaly's own scope, for an open alert incident whose anomaly ended",
		() => {
			const testDb = createTestDb(createdDbs)
			return Effect.gen(function* () {
				yield* insertRule(ORG, DEFAULT_RULE, DEFAULT_ANOMALY_RULE_NAME)
				yield* insertAnomaly({
					id: "00000000-0000-4000-8000-000000000313",
					signalType: "throughput",
					serviceName: "cart",
					severity: "warning",
					status: "resolved",
					lastObservedValue: 3,
					baselineMedian: 1200,
				})
				yield* insertOpenAlertIncident(DEFAULT_RULE, "00000000-0000-4000-8000-000000000313")
				const source = yield* AnomalyAlertSource

				assert.deepStrictEqual(yield* source.observe(ORG, DEFAULT_RULE), [
					{
						groupKey: "00000000-0000-4000-8000-000000000313",
						value: 0,
						detail: "The anomaly ended",
						anomalyIncidentId: asAnomalyId("00000000-0000-4000-8000-000000000313"),
						errorIssueId: null,
						serviceName: "cart",
						deploymentEnv: "production",
						signalType: "throughput",
						groupLabel: "cart (production)",
					},
				])
			}).pipe(Effect.provide(Layer.merge(makeLayer(testDb), testDb.layer)))
		},
	)

	it.effect("hands an open anomaly to a strictly more specific rule, never to an equal one", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* insertRule(ORG, DEFAULT_RULE, DEFAULT_ANOMALY_RULE_NAME)
			yield* checkoutSpike()
			yield* insertOpenAlertIncident(DEFAULT_RULE, CHECKOUT_SPIKE)
			yield* insertRule(ORG, CHECKOUT_RULE, "Checkout anomalies", { serviceNames: ["checkout"] })

			// The default resolves its incident and the narrower rule opens one.
			assert.deepStrictEqual(yield* observedKeys(DEFAULT_RULE), [[CHECKOUT_SPIKE, 0]])
			assert.deepStrictEqual(yield* observedKeys(CHECKOUT_RULE), [[CHECKOUT_SPIKE, 2]])
		}).pipe(Effect.provide(Layer.merge(makeLayer(testDb), testDb.layer)))
	})

	it.effect("keeps an open anomaly when an equally specific rule with a lower id appears", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* insertRule(ORG, CHECKOUT_RULE, "Checkout anomalies", { serviceNames: ["checkout"] })
			yield* checkoutSpike()
			yield* insertOpenAlertIncident(CHECKOUT_RULE, CHECKOUT_SPIKE)
			yield* insertRule(ORG, DEFAULT_RULE, "Checkout again", { serviceNames: ["checkout"] })

			assert.deepStrictEqual(yield* observedKeys(CHECKOUT_RULE), [[CHECKOUT_SPIKE, 2]])
			assert.deepStrictEqual(yield* observedKeys(DEFAULT_RULE), [])
		}).pipe(Effect.provide(Layer.merge(makeLayer(testDb), testDb.layer)))
	})

	it.effect("releases an anomaly from a disabled rule to the next rule covering it", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* insertRule(ORG, DEFAULT_RULE, DEFAULT_ANOMALY_RULE_NAME)
			yield* insertRule(ORG, CHECKOUT_RULE, "Checkout anomalies", { serviceNames: ["checkout"] })
			yield* checkoutSpike()
			yield* insertOpenAlertIncident(CHECKOUT_RULE, CHECKOUT_SPIKE)
			yield* disableRule(CHECKOUT_RULE)

			assert.deepStrictEqual(yield* observedKeys(DEFAULT_RULE), [[CHECKOUT_SPIKE, 2]])
			const source = yield* AnomalyAlertSource
			const released = yield* source.observe(ORG, CHECKOUT_RULE)
			assert.deepStrictEqual(
				Arr.map(released, (observation) => [
					observation.groupKey,
					observation.value,
					observation.detail,
				]),
				[[CHECKOUT_SPIKE, 0, "The anomaly moved off this rule"]],
			)
		}).pipe(Effect.provide(Layer.merge(makeLayer(testDb), testDb.layer)))
	})
})

describe("AnomalyAlertSource.backfillDefaultRules", () => {
	const anomalyRuleNames = (orgId: OrgId) =>
		Effect.gen(function* () {
			const database = yield* Database
			const rows = yield* database.execute((db) =>
				db.run(
					PG.from(AlertRules)
						.select("name", "signalType", "enabled")
						.where(($) => [$.orgId.eq(orgId), $.signalType.eq("anomaly")]),
				),
			)
			return Arr.map(rows, (row) => row.name)
		})

	it.effect("gives orgs with an open anomaly one default rule, once", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* insertAnomaly({
				id: "00000000-0000-4000-8000-000000000312",
				signalType: "latency_p95",
				serviceName: "api",
				severity: "warning",
				lastObservedValue: 840,
				baselineMedian: 210,
			})
			// Only resolved anomalies: nothing to page on, so no rule yet.
			yield* insertAnomaly({
				id: "00000000-0000-4000-8000-000000000314",
				orgId: QUIET_ORG,
				signalType: "throughput",
				serviceName: "api",
				severity: "warning",
				status: "resolved",
				lastObservedValue: 3,
				baselineMedian: 1200,
			})
			const source = yield* AnomalyAlertSource

			assert.strictEqual(yield* source.backfillDefaultRules, 1)
			assert.strictEqual(yield* source.backfillDefaultRules, 0)
			assert.deepStrictEqual(yield* anomalyRuleNames(ORG), [DEFAULT_ANOMALY_RULE_NAME])
			assert.deepStrictEqual(yield* anomalyRuleNames(QUIET_ORG), [])

			// The new rule owns the open anomaly.
			const [ruleRow] = yield* (yield* Database).execute((db) =>
				db.run(
					PG.from(AlertRules)
						.select("id")
						.where(($) => [$.orgId.eq(ORG)]),
				),
			)
			assert.isDefined(ruleRow)
			const observations = yield* source.observe(ORG, ruleRow?.id ?? DEFAULT_RULE)
			assert.deepStrictEqual(
				Arr.map(observations, (observation) => observation.groupKey),
				["00000000-0000-4000-8000-000000000312"],
			)
		}).pipe(Effect.provide(Layer.merge(makeLayer(testDb), testDb.layer)))
	})

	it.effect("skips orgs that have a default rule and works around a taken name", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* insertAnomaly({
				id: "00000000-0000-4000-8000-000000000312",
				signalType: "latency_p95",
				serviceName: "api",
				severity: "warning",
				lastObservedValue: 840,
				baselineMedian: 210,
			})
			// A scoped anomaly rule holds the default name but is not the default.
			yield* insertRule(ORG, CHECKOUT_RULE, DEFAULT_ANOMALY_RULE_NAME, { serviceNames: ["checkout"] })
			yield* insertAnomaly({
				id: "00000000-0000-4000-8000-000000000314",
				orgId: QUIET_ORG,
				signalType: "throughput",
				serviceName: "api",
				severity: "warning",
				lastObservedValue: 3,
				baselineMedian: 1200,
			})
			yield* insertRule(QUIET_ORG, DEFAULT_RULE, "Already here")
			const source = yield* AnomalyAlertSource

			assert.strictEqual(yield* source.backfillDefaultRules, 1)
			assert.deepStrictEqual(Arr.sort(yield* anomalyRuleNames(ORG), Order.String), [
				DEFAULT_ANOMALY_RULE_NAME,
				DEFAULT_ANOMALY_RULE_FALLBACK_NAME,
			])
			assert.deepStrictEqual(yield* anomalyRuleNames(QUIET_ORG), ["Already here"])
			assert.strictEqual(yield* source.backfillDefaultRules, 0)
		}).pipe(Effect.provide(Layer.merge(makeLayer(testDb), testDb.layer)))
	})

	it.effect("numbers the default rule's name when both default names are taken", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* insertAnomaly({
				id: "00000000-0000-4000-8000-000000000312",
				signalType: "latency_p95",
				serviceName: "api",
				severity: "warning",
				lastObservedValue: 840,
				baselineMedian: 210,
			})
			yield* insertRule(ORG, CHECKOUT_RULE, DEFAULT_ANOMALY_RULE_NAME, { serviceNames: ["checkout"] })
			yield* insertRule(ORG, DEFAULT_RULE, DEFAULT_ANOMALY_RULE_FALLBACK_NAME, {
				serviceNames: ["cart"],
			})
			const source = yield* AnomalyAlertSource

			assert.strictEqual(yield* source.backfillDefaultRules, 1)
			assert.include(yield* anomalyRuleNames(ORG), `${DEFAULT_ANOMALY_RULE_NAME} (default 2)`)
		}).pipe(Effect.provide(Layer.merge(makeLayer(testDb), testDb.layer)))
	})
})
