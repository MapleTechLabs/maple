import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { AlertMaintenanceWindowCreateRequest, AlertMaintenanceWindowUpdateRequest } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AlertsService, type AlertsServiceApi } from "./AlertsService"
import { AlertMaintenanceWindowsService } from "./AlertMaintenanceWindowsService"
import { AlertSilencesService } from "./AlertSilencesService"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminRoles,
	asOrgId,
	asUserId,
	createErrorRateRule,
	createWebhookDestination,
	makeLayer,
	makeWarehouseStub,
	tracesRow,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = asOrgId("org_maintenance_alerts")
const userId = asUserId("user_maintenance_alerts")

/** A rule on `checkout` breaching at a 10% error rate, and the webhooks it sends. */
const setup = () => {
	const testDb = createTestDb(trackedDbs)
	const tracesAggregateRows: ReadonlyArray<Record<string, unknown>> = [
		tracesRow({
			count: 200,
			avgDuration: 40,
			p50Duration: 20,
			p95Duration: 120,
			p99Duration: 240,
			errorRate: 10,
			satisfiedCount: 180,
			toleratingCount: 10,
			apdexScore: 0.925,
		}),
	]
	const state = { tracesAggregateRows }
	const sent: Array<string> = []
	const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
		sent.push(new Headers(init?.headers).get("x-maple-event-type") ?? "")
		return new Response("ok", { status: 200 })
	}
	return { sent, layer: makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl }) }
}

const ticks = (alerts: AlertsServiceApi, count: number) =>
	Effect.forEach(
		Arr.range(1, count),
		() => TestClock.adjust(Duration.minutes(1)).pipe(Effect.andThen(alerts.runSchedulerTick())),
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

describe("maintenance windows hold back alerts", () => {
	it.effect("silences a matching trigger during an occurrence and pages once it ends", () => {
		const { sent, layer } = setup()
		return Effect.gen(function* () {
			// Tuesday 22:13:20 UTC: the 22:00 occurrence runs until 22:30.
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const windows = yield* AlertMaintenanceWindowsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			const window = yield* windows.create(
				orgId,
				userId,
				adminRoles,
				new AlertMaintenanceWindowCreateRequest({
					name: "Nightly deploy",
					matchers: { services: ["checkout"] },
					schedule: {
						_tag: "weekly",
						timeZone: "UTC",
						days: ["tue"],
						startTime: "22:00",
						durationMinutes: 30,
					},
				}),
			)

			yield* ticks(alerts, 2)
			const [held] = (yield* alerts.listIncidents(orgId)).incidents
			assert.isNotNull(held?.silencedAt)
			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:silenced"])
			assert.deepStrictEqual(sent, [])

			// Past 22:30 the occurrence is over and the owed page goes out, once.
			yield* ticks(alerts, 20)
			const [incident] = (yield* alerts.listIncidents(orgId)).incidents
			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:silenced", "trigger:success"])
			assert.deepStrictEqual(sent, ["trigger"])
			assert.isNull(incident?.silencedAt)
			// The incident names the occurrence's silence, which names the window.
			const silenceId = incident?.silenceId
			assert.isTrue(silenceId !== null && silenceId !== undefined)
			if (silenceId !== null && silenceId !== undefined) {
				const silence = yield* AlertSilencesService.use((silences) => silences.get(orgId, silenceId))
				assert.strictEqual(silence.maintenanceWindowId, window.id)
			}
		}).pipe(Effect.provide(layer))
	})

	it.effect("holds the page through a disable and re-enable, then sends it once at the real end", () => {
		const { sent, layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const windows = yield* AlertMaintenanceWindowsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			const window = yield* windows.create(
				orgId,
				userId,
				adminRoles,
				new AlertMaintenanceWindowCreateRequest({
					name: "Nightly deploy",
					matchers: { services: ["checkout"] },
					schedule: {
						_tag: "weekly",
						timeZone: "UTC",
						days: ["tue"],
						startTime: "22:00",
						durationMinutes: 30,
					},
				}),
			)
			yield* ticks(alerts, 2)

			// Off and on again between two checks: the occurrence's silence ends, then reopens.
			const toggle = (enabled: boolean) =>
				windows.update(
					orgId,
					userId,
					adminRoles,
					window.id,
					new AlertMaintenanceWindowUpdateRequest({ enabled }),
				)
			yield* toggle(false)
			yield* toggle(true)
			yield* ticks(alerts, 5)
			const [held] = (yield* alerts.listIncidents(orgId)).incidents
			assert.isNotNull(held?.silencedAt)
			assert.deepStrictEqual(sent, [])

			// 22:13 + 7 minutes so far; past 22:30 the page goes out once.
			yield* ticks(alerts, 15)
			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:silenced", "trigger:success"])
			assert.deepStrictEqual(sent, ["trigger"])
		}).pipe(Effect.provide(layer))
	})
})
