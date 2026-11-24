import {
	AlertRuleUpsertRequest,
	WebhookAlertDestinationConfig,
	type AlertThreshold,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Duration, Effect, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import type { AlertIncidentActor } from "./AlertIncidentAckService"
import { type AlertsServiceApi } from "./AlertsService"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminRoles,
	alertServices,
	asOrgId,
	asUserId,
	makeLayer,
	makeWarehouseStub,
	tracesRow,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const errorRateRows = (errorRate: number): ReadonlyArray<Record<string, unknown>> => [
	tracesRow({
		count: 200,
		avgDuration: 40,
		p50Duration: 20,
		p95Duration: 120,
		p99Duration: 240,
		errorRate,
		satisfiedCount: 180,
		toleratingCount: 10,
		apdexScore: 0.925,
	}),
]

interface Request {
	readonly event: string
	readonly body: string
}

const recordingFetch = (requests: Array<Request>) =>
	(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const body = init?.body
		requests.push({
			event: new Headers(init?.headers).get("x-maple-event-type") ?? "",
			body: body instanceof Uint8Array ? new TextDecoder().decode(body) : typeof body === "string" ? body : "",
		})
		return new Response("ok", { status: 200 })
	}) as typeof fetch

const tick = (alerts: AlertsServiceApi, minutes = 1) =>
	Effect.gen(function* () {
		yield* TestClock.adjust(Duration.minutes(minutes))
		yield* alerts.runSchedulerTick()
	})

const ticks = (alerts: AlertsServiceApi, minutes: number) =>
	Effect.forEach(Arr.range(1, minutes), () => tick(alerts), { discard: true })

const critical = (destinationId: AlertThreshold["destinationIds"][number]): AlertThreshold => ({
	severity: "critical",
	value: 5,
	upper: null,
	recoveryValue: null,
	destinationIds: [destinationId],
	escalationChainId: null,
})

/** A firing incident on a rule that notifies one webhook. */
const firing = (alerts: Effect.Success<typeof alertServices>, orgId: OrgId, userId: UserId) =>
	Effect.gen(function* () {
		const team = yield* alerts.createDestination(
			orgId,
			userId,
			adminRoles,
			new WebhookAlertDestinationConfig({
				type: "webhook",
				name: "team",
				enabled: true,
				url: "https://example.com/team",
				signingSecret: "team-secret",
			}),
		)
		yield* alerts.createRule(
			orgId,
			userId,
			adminRoles,
			new AlertRuleUpsertRequest({
				name: "Checkout error rate",
				enabled: true,
				serviceNames: ["checkout"],
				signalType: "error_rate",
				comparator: "gt",
				thresholds: [critical(team.id)],
				windowMinutes: 5,
				minimumSampleCount: 10,
				consecutiveBreachesRequired: 2,
				consecutiveHealthyRequired: 2,
				renotifyIntervalMinutes: 60,
			}),
		)
		yield* ticks(alerts, 2)
		const [incident] = (yield* alerts.listIncidents(orgId)).incidents
		if (incident === undefined) return yield* Effect.die("expected an open incident")
		return incident
	})

describe("AlertsService manual resolve", () => {
	const dana: AlertIncidentActor = { userId: asUserId("user_dana"), name: "Dana Kim", source: "web" }

	it.effect("closes the incident, sends an all-clear that says who resolved it, and refuses a second resolve", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<Request> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const orgId = asOrgId("org_manual_resolve")
			const incident = yield* firing(alerts, orgId, asUserId("user_manual_resolve"))

			const resolved = yield* alerts.resolveIncident(orgId, incident.id, dana)
			assert.strictEqual(resolved.status, "resolved")
			yield* tick(alerts)

			const allClear = Arr.findFirst(requests, (request) => request.event === "resolve")
			assert.isTrue(allClear._tag === "Some")
			assert.isTrue(Str.includes("Resolved by Dana Kim")(allClear._tag === "Some" ? allClear.value.body : ""))

			const again = yield* Effect.flip(alerts.resolveIncident(orgId, incident.id, dana))
			assert.strictEqual(again._tag, "@maple/http/errors/AlertIncidentResolvedError")
			const elsewhere = yield* Effect.flip(
				alerts.resolveIncident(asOrgId("org_manual_resolve_other"), incident.id, dana),
			)
			assert.strictEqual(elsewhere._tag, "@maple/http/errors/AlertIncidentNotFoundError")
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) })),
		)
	})

	it.effect("opens nothing while the rule still breaches, and opens again once it has been healthy", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<Request> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const orgId = asOrgId("org_manual_quiet")
			const incident = yield* firing(alerts, orgId, asUserId("user_manual_quiet"))
			yield* alerts.resolveIncident(orgId, incident.id, dana)

			// Still breaching for ten more checks: the resolve stands.
			yield* ticks(alerts, 10)
			assert.deepStrictEqual(
				Arr.map((yield* alerts.listIncidents(orgId)).incidents, (row) => row.status),
				["resolved"],
			)

			// Healthy once, then breaching again: that is a new incident.
			state.tracesAggregateRows = errorRateRows(0.5)
			yield* ticks(alerts, 2)
			state.tracesAggregateRows = errorRateRows(10)
			yield* ticks(alerts, 2)
			assert.sameMembers(
				Arr.map((yield* alerts.listIncidents(orgId)).incidents, (row) => row.status),
				["resolved", "open"],
			)
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) })),
		)
	})
})
