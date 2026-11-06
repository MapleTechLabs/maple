// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AnomalyIncidents } from "@maple/db/tables"
import {
	AlertRuleUpsertRequest,
	AnomalyIncidentId,
	ErrorIssueId,
	UNGROUPED_GROUP_KEY,
	type AlertDestinationId,
	type AlertThresholds,
	type AnomalyIncidentSeverity,
	type AnomalySignalType,
} from "@maple/domain/http"
import { Array as Arr, Clock, Duration, Effect, Layer, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { fakeChatSessions } from "@maple/backend/platform/chat-sessions-fake"
import type { IncidentPushEvent } from "@maple/backend/services/push/MobilePushService"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { AlertsService } from "./AlertsService"
import { AnomalyAlertSource } from "./anomaly/AnomalyAlertSource"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminRoles,
	asOrgId,
	asUserId,
	createWebhookDestination,
	makeLayer,
	makeWarehouseStub,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const asAnomalyId = Schema.decodeUnknownSync(AnomalyIncidentId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)

const orgId = asOrgId("org_anomaly_alerts")
const userId = asUserId("user_anomaly_alerts")

/** Fetch bodies arrive as a string or, from the Effect HTTP client, as bytes. */
const requestBodyText = (body: RequestInit["body"]): string =>
	body instanceof Uint8Array ? new TextDecoder().decode(body) : typeof body === "string" ? body : ""

const harness = () => {
	const testDb = createTestDb(trackedDbs)
	const bodies: Array<string> = []
	const turns: Array<string> = []
	const fetchImpl: typeof fetch = async (_input, init) => {
		bodies.push(requestBodyText(init?.body))
		return new Response("ok", { status: 200 })
	}
	const chatSessions = fakeChatSessions(() => ({
		beginTurn: async (input: { sessionId: string; messageId: string }) => {
			turns.push(input.sessionId)
			return { cursor: 0, messageId: input.messageId, turnMessageId: input.messageId }
		},
	}))
	const pushes: Array<IncidentPushEvent> = []
	const layer = Layer.mergeAll(
		makeLayer(testDb, makeWarehouseStub({}), { fetch: fetchImpl, chatSessions, pushes }),
		AnomalyAlertSource.layer.pipe(Layer.provide(testDb.layer)),
		testDb.layer,
	)
	return { testDb, bodies, turns, pushes, layer }
}

const pushedEvents = (pushes: ReadonlyArray<IncidentPushEvent>) =>
	Arr.map(pushes, (push) => `${push.eventType}:${push.severity}`)

interface SeededAnomaly {
	readonly id: string
	readonly signalType: AnomalySignalType
	readonly serviceName: string
	readonly severity: AnomalyIncidentSeverity
	readonly lastObservedValue: number
	readonly baselineMedian: number
	readonly errorIssueId?: string
}

const detectorKey = (anomaly: Pick<SeededAnomaly, "signalType" | "serviceName">) =>
	`${anomaly.signalType}:production:${anomaly.serviceName}`

const insertAnomaly = (anomaly: SeededAnomaly) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = yield* Clock.currentTimeMillis
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(AnomalyIncidents).values({
					id: asAnomalyId(anomaly.id),
					orgId,
					detectorKey: detectorKey(anomaly),
					signalType: anomaly.signalType,
					serviceName: anomaly.serviceName,
					deploymentEnv: "production",
					fingerprintHash: null,
					errorIssueId: anomaly.errorIssueId === undefined ? null : asIssueId(anomaly.errorIssueId),
					status: "open",
					severity: anomaly.severity,
					openedValue: anomaly.lastObservedValue,
					baselineMedian: anomaly.baselineMedian,
					baselineSigma: 0.001,
					thresholdValue: anomaly.baselineMedian * 2,
					lastObservedValue: anomaly.lastObservedValue,
					firstTriggeredAt: now,
					lastTriggeredAt: now,
					resolvedAt: null,
					resolveReason: null,
					dedupeKey: `dedupe-${anomaly.id}`,
					createdAt: now,
					updatedAt: now,
				}),
			),
		)
	}).pipe(Effect.orDie)

const updateAnomaly = (testDb: TestDb, id: string, set: "severity = 'critical'" | "status = 'resolved'") =>
	Effect.promise(() => executeSql(testDb, `update anomaly_incidents set ${set} where id = $1`, [id]))

const countRows = (testDb: TestDb, table: "error_issues" | "alert_delivery_events") =>
	Effect.promise(() =>
		queryFirstRow<{ n: number }>(testDb, `select count(*)::int as n from ${table} where org_id = $1`, [
			orgId,
		]),
	).pipe(Effect.map((row) => row?.n ?? 0))

const enableTriage = (testDb: TestDb) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			"insert into ai_triage_settings (org_id, enabled, max_runs_per_day, updated_at) values ($1, true, 100, now())",
			[orgId],
		),
	)

const criticalTier = (destinationId: AlertDestinationId) => ({
	severity: "critical" as const,
	value: 2,
	upper: null,
	recoveryValue: null,
	destinationIds: [destinationId],
})

/** Both tiers; only the critical one pages `destinationId`. */
const criticalRouted = (destinationId: AlertDestinationId): AlertThresholds => [
	{ severity: "warning", value: 1, upper: null, recoveryValue: null, destinationIds: [] },
	{ severity: "critical", value: 2, upper: null, recoveryValue: null, destinationIds: [destinationId] },
]

const anomalyRule = (input: {
	readonly name: string
	readonly thresholds: AlertThresholds
	readonly serviceNames?: ReadonlyArray<string>
	readonly enabled?: boolean
}) =>
	new AlertRuleUpsertRequest({
		name: input.name,
		enabled: input.enabled ?? true,
		signalType: "anomaly",
		comparator: "gte",
		windowMinutes: 5,
		thresholds: input.thresholds,
		...(input.serviceNames === undefined ? undefined : { serviceNames: input.serviceNames }),
	})

/** The org's state row keys, heartbeat first. */
const stateKeys = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ keys: Array<string> | null }>(
			testDb,
			"select array_agg(group_key order by group_key = $2 desc, group_key) as keys from alert_rule_states where org_id = $1",
			[orgId, UNGROUPED_GROUP_KEY],
		),
	).pipe(Effect.map((row) => row?.keys ?? []))

const nextTick = Effect.gen(function* () {
	yield* TestClock.adjust(Duration.minutes(1))
	const alerts = yield* AlertsService
	yield* alerts.runSchedulerTick()
})

const errorRateSpike: SeededAnomaly = {
	id: "00000000-0000-4000-8000-00000000a001",
	signalType: "error_rate",
	serviceName: "checkout",
	severity: "warning",
	lastObservedValue: 0.042,
	baselineMedian: 0.003,
	errorIssueId: "00000000-0000-4000-8000-00000000e001",
}

describe("AlertsService anomaly rules", () => {
	it.effect("the default rule opens a linked incident for an open anomaly without paging", () => {
		const { testDb, turns, layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* enableTriage(testDb)
			yield* insertAnomaly(errorRateSpike)
			const created = yield* AnomalyAlertSource.use((source) => source.backfillDefaultRules)
			assert.strictEqual(created, 1)

			yield* alerts.runSchedulerTick()

			const incidents = (yield* alerts.listIncidents(orgId)).incidents
			assert.lengthOf(incidents, 1)
			expect(incidents[0]).toMatchObject({
				status: "open",
				signalType: "anomaly",
				groupKey: errorRateSpike.id,
				severity: "warning",
				anomalyIncidentId: errorRateSpike.id,
				errorIssueId: errorRateSpike.errorIssueId,
			})
			// The anomaly already has its issue and its triage; the alert adds neither.
			assert.strictEqual(yield* countRows(testDb, "error_issues"), 0)
			assert.deepStrictEqual(turns, [])
			// The default rule routes no tier, so nothing is delivered.
			assert.strictEqual(yield* countRows(testDb, "alert_delivery_events"), 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("an unrouted tier never pushes to phones, even for a critical anomaly", () => {
		const { pushes, layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* insertAnomaly({ ...errorRateSpike, severity: "critical" })
			yield* AnomalyAlertSource.use((source) => source.backfillDefaultRules)

			yield* alerts.runSchedulerTick()
			yield* nextTick

			expect((yield* alerts.listIncidents(orgId)).incidents[0]).toMatchObject({ severity: "critical" })
			assert.deepStrictEqual(pushes, [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("a routed critical tier pages its destination with the anomaly's own sentence", () => {
		const { bodies, pushes, layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				anomalyRule({
					name: "Checkout anomalies",
					serviceNames: ["checkout"],
					thresholds: criticalRouted(destination.id),
				}),
			)
			yield* insertAnomaly({ ...errorRateSpike, severity: "critical" })

			yield* alerts.runSchedulerTick()

			const incidents = (yield* alerts.listIncidents(orgId)).incidents
			expect(incidents[0]).toMatchObject({ status: "open", severity: "critical" })
			const events = (yield* alerts.listDeliveryEvents(orgId)).events
			assert.deepStrictEqual(
				Arr.map(events, (event) => [event.eventType, event.destinationId]),
				[["trigger", destination.id]],
			)
			assert.deepStrictEqual(pushedEvents(pushes), ["trigger:critical"])
			const trigger = Schema.decodeSync(
				Schema.fromJsonString(
					Schema.Struct({
						eventType: Schema.String,
						rule: Schema.Struct({ groupKey: Schema.String, groupLabel: Schema.String }),
						observed: Schema.Struct({ value: Schema.Number, detail: Schema.String }),
					}),
				),
			)(bodies[0] ?? "")
			assert.deepStrictEqual(trigger, {
				eventType: "trigger",
				// The group key is the anomaly incident's id; people see its service and environment.
				rule: { groupKey: errorRateSpike.id, groupLabel: "checkout (production)" },
				observed: {
					value: 2,
					detail: "error rate 4.2% vs baseline 0.3% in checkout (production)",
				},
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("follows the anomaly from warning to critical and resolves with it", () => {
		const { testDb, pushes, layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				anomalyRule({
					name: "Checkout anomalies",
					serviceNames: ["checkout"],
					thresholds: criticalRouted(destination.id),
				}),
			)
			yield* insertAnomaly(errorRateSpike)

			yield* alerts.runSchedulerTick()
			const opened = (yield* alerts.listIncidents(orgId)).incidents
			expect(opened[0]).toMatchObject({ status: "open", severity: "warning" })
			assert.strictEqual(yield* countRows(testDb, "alert_delivery_events"), 0)
			// The warning tier is unrouted, so the phone stays quiet until it escalates.
			assert.deepStrictEqual(pushes, [])

			yield* updateAnomaly(testDb, errorRateSpike.id, "severity = 'critical'")
			yield* nextTick
			const escalated = (yield* alerts.listIncidents(orgId)).incidents
			assert.lengthOf(escalated, 1)
			expect(escalated[0]).toMatchObject({
				status: "open",
				severity: "critical",
				peakSeverity: "critical",
			})
			assert.isNotEmpty(pushes)
			assert.isTrue(Arr.every(pushes, (push) => push.severity === "critical"))

			yield* updateAnomaly(testDb, errorRateSpike.id, "status = 'resolved'")
			yield* nextTick
			const resolved = (yield* alerts.listIncidents(orgId)).incidents
			expect(resolved[0]).toMatchObject({ status: "resolved" })
			// The escalation paged the critical destination, so its resolve reaches it too.
			const events = (yield* alerts.listDeliveryEvents(orgId)).events
			assert.includeMembers(
				Arr.map(events, (event) => `${event.eventType}:${event.destinationId}`),
				[`resolve:${destination.id}`],
			)
			assert.strictEqual(yield* countRows(testDb, "error_issues"), 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect(
		"a warning stays on the default rule and hands over to a critical-only rule once critical",
		() => {
			const { testDb, layer } = harness()
			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				yield* insertAnomaly(errorRateSpike)
				yield* AnomalyAlertSource.use((source) => source.backfillDefaultRules)
				const scoped = yield* alerts.createRule(
					orgId,
					userId,
					adminRoles,
					anomalyRule({
						name: "Checkout critical anomalies",
						serviceNames: ["checkout"],
						thresholds: [criticalTier(destination.id)],
					}),
				)

				// The scoped rule has no warning tier, so the default rule takes the warning, unrouted.
				yield* alerts.runSchedulerTick()
				const warning = (yield* alerts.listIncidents(orgId)).incidents
				assert.lengthOf(warning, 1)
				assert.notStrictEqual(warning[0]?.ruleId, scoped.id)
				assert.strictEqual(yield* countRows(testDb, "alert_delivery_events"), 0)

				yield* updateAnomaly(testDb, errorRateSpike.id, "severity = 'critical'")
				yield* nextTick
				const handedOver = (yield* alerts.listIncidents(orgId)).incidents
				assert.sameDeepMembers(
					Arr.map(handedOver, (incident) => [incident.ruleId === scoped.id, incident.status]),
					[
						[false, "resolved"],
						[true, "open"],
					],
				)
				const events = (yield* alerts.listDeliveryEvents(orgId)).events
				assert.deepStrictEqual(
					Arr.map(events, (event) => [event.eventType, event.destinationId]),
					[["trigger", destination.id]],
				)
			}).pipe(Effect.provide(layer))
		},
	)

	it.effect("a more specific rule takes an open anomaly over, and takes it back when re-enabled", () => {
		const { bodies, layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* insertAnomaly(errorRateSpike)
			yield* AnomalyAlertSource.use((source) => source.backfillDefaultRules)
			yield* alerts.runSchedulerTick()
			const openOn = Effect.gen(function* () {
				const incidents = (yield* alerts.listIncidents(orgId)).incidents
				return Arr.filterMap(incidents, (incident) =>
					incident.status === "open" ? Result.succeed(incident.ruleId) : Result.failVoid,
				)
			})
			const [defaultRuleId] = yield* openOn

			const scopedRequest = (enabled: boolean) =>
				anomalyRule({
					name: "Checkout anomalies",
					serviceNames: ["checkout"],
					thresholds: [
						{ ...criticalTier(destination.id), severity: "warning", value: 1 },
						criticalTier(destination.id),
					],
					enabled,
				})
			const scoped = yield* alerts.createRule(orgId, userId, adminRoles, scopedRequest(true))
			yield* nextTick
			assert.deepStrictEqual(yield* openOn, [scoped.id])

			// Disabling it resolves its incident from the stored label, with no observation at hand.
			yield* alerts.updateRule(orgId, userId, adminRoles, scoped.id, scopedRequest(false))
			yield* nextTick
			assert.deepStrictEqual(yield* openOn, [defaultRuleId])
			const sent = Arr.map(
				bodies,
				Schema.decodeUnknownSync(
					Schema.fromJsonString(
						Schema.Struct({
							eventType: Schema.String,
							rule: Schema.Struct({ groupLabel: Schema.optionalKey(Schema.String) }),
						}),
					),
				),
			)
			assert.deepStrictEqual(
				Arr.filter(sent, (body) => body.eventType === "resolve"),
				[{ eventType: "resolve", rule: { groupLabel: "checkout (production)" } }],
			)

			yield* alerts.updateRule(orgId, userId, adminRoles, scoped.id, scopedRequest(true))
			yield* nextTick
			assert.deepStrictEqual(yield* openOn, [scoped.id])
		}).pipe(Effect.provide(layer))
	})

	it.effect("copies an issue the anomaly gains after its alert incident opened", () => {
		const { testDb, layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const { errorIssueId: _issue, ...withoutIssue } = errorRateSpike
			yield* insertAnomaly(withoutIssue)
			yield* AnomalyAlertSource.use((source) => source.backfillDefaultRules)
			yield* alerts.runSchedulerTick()
			assert.isNull((yield* alerts.listIncidents(orgId)).incidents[0]?.errorIssueId ?? null)

			yield* Effect.promise(() =>
				executeSql(testDb, "update anomaly_incidents set error_issue_id = $2 where id = $1", [
					errorRateSpike.id,
					errorRateSpike.errorIssueId,
				]),
			)
			yield* nextTick
			const [linked] = (yield* alerts.listIncidents(orgId)).incidents
			expect(linked).toMatchObject({
				errorIssueId: errorRateSpike.errorIssueId,
				groupLabel: "checkout (production)",
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("a two-service rule opens incidents only for real anomalies in its scope", () => {
		const { layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* insertAnomaly({ ...errorRateSpike, severity: "critical" })
			yield* insertAnomaly({
				id: "00000000-0000-4000-8000-00000000a003",
				signalType: "latency_p95",
				serviceName: "search",
				severity: "critical",
				lastObservedValue: 1800,
				baselineMedian: 300,
			})
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				anomalyRule({
					name: "Checkout and cart anomalies",
					serviceNames: ["checkout", "cart"],
					thresholds: [
						{
							severity: "warning",
							value: 1,
							upper: null,
							recoveryValue: null,
							destinationIds: [destination.id],
						},
					],
				}),
			)

			yield* alerts.runSchedulerTick()
			yield* nextTick

			assert.deepStrictEqual(
				Arr.map((yield* alerts.listIncidents(orgId)).incidents, (incident) => [
					incident.ruleId,
					incident.groupKey,
					incident.status,
				]),
				[[rule.id, errorRateSpike.id, "open"]],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("keeps one alert incident and its state while the detector rewrites the anomaly's key", () => {
		const { testDb, layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* insertAnomaly(errorRateSpike)
			yield* AnomalyAlertSource.use((source) => source.backfillDefaultRules)

			yield* alerts.runSchedulerTick()
			const [opened] = (yield* alerts.listIncidents(orgId)).incidents
			yield* Effect.promise(() =>
				executeSql(testDb, "update anomaly_incidents set detector_key = $2 where id = $1", [
					errorRateSpike.id,
					"error_spike:production:promoted-fingerprint",
				]),
			)
			yield* nextTick
			yield* nextTick

			const incidents = (yield* alerts.listIncidents(orgId)).incidents
			assert.deepStrictEqual(
				Arr.map(incidents, (incident) => [incident.id, incident.status]),
				[[opened?.id, "open"]],
			)
			// Housekeeping keeps the per-anomaly state beside the heartbeat on each tick.
			assert.deepStrictEqual(yield* stateKeys(testDb), [UNGROUPED_GROUP_KEY, errorRateSpike.id])
		}).pipe(Effect.provide(layer))
	})

	it.effect("a rule test reads the open anomalies in an unsaved rule's scope", () => {
		const { layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* insertAnomaly({ ...errorRateSpike, severity: "critical" })
			const testScope = (serviceNames: ReadonlyArray<string>) =>
				alerts.testRule(
					orgId,
					userId,
					adminRoles,
					anomalyRule({
						name: "Unsaved",
						serviceNames,
						thresholds: criticalRouted(destination.id),
					}),
				)

			const checkout = yield* testScope(["checkout"])
			expect(checkout).toMatchObject({
				status: "breached",
				value: 2,
				reason: "error rate 4.2% vs baseline 0.3% in checkout (production)",
			})
			const payments = yield* testScope(["payments"])
			expect(payments).toMatchObject({
				status: "healthy",
				value: 0,
				reason: "No open anomaly in this rule's scope",
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("an idle rule records that it ran, without opening anything", () => {
		const { testDb, layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				anomalyRule({
					name: "Checkout anomalies",
					serviceNames: ["checkout"],
					thresholds: criticalRouted(destination.id),
				}),
			)
			assert.isNull(rule.lastEvaluatedAt)

			yield* alerts.runSchedulerTick()

			// The dashboard reads "last evaluated" from the rule's state rows.
			const heartbeat = yield* Effect.promise(() =>
				queryFirstRow<{ last_evaluated_at: string | null; last_status: string }>(
					testDb,
					"select last_evaluated_at, last_status from alert_rule_states where rule_id = $1 and group_key = $2",
					[rule.id, UNGROUPED_GROUP_KEY],
				),
			)
			assert.isNotNull(heartbeat?.last_evaluated_at ?? null)
			assert.strictEqual(heartbeat?.last_status, "healthy")
			assert.deepStrictEqual((yield* alerts.listIncidents(orgId)).incidents, [])
			assert.deepStrictEqual(yield* stateKeys(testDb), [UNGROUPED_GROUP_KEY])
		}).pipe(Effect.provide(layer))
	})

	it.effect(
		"drops an ended anomaly's state row once its incident has closed, keeping the heartbeat",
		() => {
			const { testDb, layer } = harness()
			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				yield* insertAnomaly(errorRateSpike)
				yield* AnomalyAlertSource.use((source) => source.backfillDefaultRules)
				yield* alerts.runSchedulerTick()
				assert.deepStrictEqual(yield* stateKeys(testDb), [UNGROUPED_GROUP_KEY, errorRateSpike.id])

				yield* updateAnomaly(testDb, errorRateSpike.id, "status = 'resolved'")
				yield* nextTick
				expect((yield* alerts.listIncidents(orgId)).incidents[0]).toMatchObject({
					status: "resolved",
				})
				yield* nextTick
				assert.deepStrictEqual(yield* stateKeys(testDb), [UNGROUPED_GROUP_KEY])
			}).pipe(Effect.provide(layer))
		},
	)

	it.effect("turning detection off resolves the alert side, though the anomaly stays open", () => {
		const { testDb, layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				anomalyRule({
					name: "Checkout anomalies",
					serviceNames: ["checkout"],
					thresholds: [
						{ ...criticalTier(destination.id), severity: "warning", value: 1 },
						criticalTier(destination.id),
					],
				}),
			)
			yield* insertAnomaly(errorRateSpike)
			yield* alerts.runSchedulerTick()
			expect((yield* alerts.listIncidents(orgId)).incidents[0]).toMatchObject({ status: "open" })

			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"insert into anomaly_detector_settings (org_id, enabled, created_at, updated_at) values ($1, false, now(), now())",
					[orgId],
				),
			)
			// Past the 30 minute reminder, which a still-open incident would have owed.
			yield* TestClock.adjust(Duration.minutes(40))
			yield* nextTick

			expect((yield* alerts.listIncidents(orgId)).incidents[0]).toMatchObject({ status: "resolved" })
			const events = Arr.map(
				(yield* alerts.listDeliveryEvents(orgId)).events,
				(event) => event.eventType,
			)
			assert.sameMembers(events, ["trigger", "resolve"])
			const anomaly = yield* Effect.promise(() =>
				queryFirstRow<{ status: string }>(
					testDb,
					"select status from anomaly_incidents where id = $1",
					[errorRateSpike.id],
				),
			)
			assert.strictEqual(anomaly?.status, "open")
		}).pipe(Effect.provide(layer))
	})
})
