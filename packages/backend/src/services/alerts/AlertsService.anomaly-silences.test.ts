import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AnomalyIncidents } from "@maple/db/tables"
import {
	AlertRuleUpsertRequest,
	AlertSilenceCreateRequest,
	AnomalyIncidentId,
	IsoDateTimeString,
	type AlertSilenceMatchers,
} from "@maple/domain/http"
import { Array as Arr, Clock, Duration, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AlertsService, type AlertsServiceApi } from "./AlertsService"
import { AlertSilencesService } from "./AlertSilencesService"
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

const orgId = asOrgId("org_anomaly_silences")
const userId = asUserId("user_anomaly_silences")
const anomalyId = Schema.decodeSync(AnomalyIncidentId)("00000000-0000-4000-8000-00000000b001")
const iso = Schema.decodeUnknownSync(IsoDateTimeString)

const harness = () => {
	const testDb = createTestDb(trackedDbs)
	const sent: Array<string> = []
	const fetchImpl: typeof fetch = async (_input, init) => {
		sent.push(new Headers(init?.headers).get("x-maple-event-type") ?? "")
		return new Response("ok", { status: 200 })
	}
	const layer = Layer.mergeAll(
		makeLayer(testDb, makeWarehouseStub({}), { fetch: fetchImpl }),
		AnomalyAlertSource.layer.pipe(Layer.provide(testDb.layer)),
		testDb.layer,
	)
	return { sent, layer }
}

/** An open critical error-rate anomaly in checkout (production). */
const insertCheckoutAnomaly = Effect.gen(function* () {
	const database = yield* Database
	const now = yield* Clock.currentTimeMillis
	yield* database.execute((db) =>
		db.run(
			PG.insertInto(AnomalyIncidents).values({
				id: anomalyId,
				orgId,
				detectorKey: "error_rate:production:checkout",
				signalType: "error_rate",
				serviceName: "checkout",
				deploymentEnv: "production",
				fingerprintHash: null,
				errorIssueId: null,
				status: "open",
				severity: "critical",
				openedValue: 0.042,
				baselineMedian: 0.003,
				baselineSigma: 0.001,
				thresholdValue: 0.006,
				lastObservedValue: 0.042,
				firstTriggeredAt: now,
				lastTriggeredAt: now,
				resolvedAt: null,
				resolveReason: null,
				dedupeKey: `dedupe-${anomalyId}`,
				createdAt: now,
				updatedAt: now,
			}),
		),
	)
}).pipe(Effect.orDie)

/**
 * An anomaly rule over every service in production, whose critical tier pages a webhook. Only Maple
 * creates the fully unscoped default, so the environment scope stands in for it here.
 */
const createUnscopedAnomalyRule = (alerts: AlertsServiceApi) =>
	Effect.gen(function* () {
		const destination = yield* createWebhookDestination(alerts, orgId, userId)
		return yield* alerts.createRule(
			orgId,
			userId,
			adminRoles,
			new AlertRuleUpsertRequest({
				name: "Production anomalies",
				enabled: true,
				signalType: "anomaly",
				environments: ["production"],
				comparator: "gte",
				windowMinutes: 5,
				thresholds: [
					{ severity: "warning", value: 1, upper: null, recoveryValue: null, destinationIds: [] },
					{
						severity: "critical",
						value: 2,
						upper: null,
						recoveryValue: null,
						destinationIds: [destination.id],
					},
				],
			}),
		)
	})

const silence = (matchers: AlertSilenceMatchers) =>
	Effect.gen(function* () {
		const silences = yield* AlertSilencesService
		const now = yield* Clock.currentTimeMillis
		return yield* silences.create(
			orgId,
			userId,
			adminRoles,
			new AlertSilenceCreateRequest({
				reason: "checkout maintenance",
				matchers,
				endsAt: iso(new Date(now + 60 * 60_000).toISOString()),
			}),
		)
	})

const ticks = (alerts: AlertsServiceApi, count: number) =>
	Effect.forEach(
		Arr.range(1, count),
		() =>
			Effect.gen(function* () {
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
			}),
		{ discard: true },
	)

const deliveries = (alerts: AlertsServiceApi) =>
	alerts
		.listDeliveryEvents(orgId)
		.pipe(
			Effect.map((page) =>
				Arr.map(Arr.reverse(page.events), (event) => `${event.eventType}:${event.status}`),
			),
		)

describe("alert silences on anomaly rules", () => {
	it.effect("a service silence holds back the page for an anomaly in that service", () => {
		const { sent, layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createUnscopedAnomalyRule(alerts)
			yield* insertCheckoutAnomaly
			const created = yield* silence({ services: ["checkout"] })

			yield* ticks(alerts, 1)

			const [incident] = (yield* alerts.listIncidents(orgId)).incidents
			expect(incident).toMatchObject({
				status: "open",
				severity: "critical",
				labels: { service: "checkout", environment: "production" },
				silenceId: created.id,
			})
			assert.isNotNull(incident?.silencedAt)
			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:silenced"])
			assert.deepStrictEqual(sent, [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("a silence on another service leaves the anomaly paging", () => {
		const { sent, layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createUnscopedAnomalyRule(alerts)
			yield* insertCheckoutAnomaly
			yield* silence({ services: ["payments"] })

			yield* ticks(alerts, 1)

			const [incident] = (yield* alerts.listIncidents(orgId)).incidents
			assert.isNull(incident?.silenceId)
			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:success"])
			assert.deepStrictEqual(sent, ["trigger"])
		}).pipe(Effect.provide(layer))
	})

	it.effect("sends the held-back page once when the silence ends while the anomaly is open", () => {
		const { sent, layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const silences = yield* AlertSilencesService
			yield* createUnscopedAnomalyRule(alerts)
			yield* insertCheckoutAnomaly
			const created = yield* silence({ services: ["checkout"] })
			yield* ticks(alerts, 2)
			assert.deepStrictEqual(sent, [])

			yield* silences.end(orgId, userId, adminRoles, created.id)
			yield* ticks(alerts, 3)

			const [incident] = (yield* alerts.listIncidents(orgId)).incidents
			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:silenced", "trigger:success"])
			assert.deepStrictEqual(sent, ["trigger"])
			assert.isNull(incident?.silencedAt)
			assert.strictEqual(incident?.silenceId, created.id)
		}).pipe(Effect.provide(layer))
	})
})
