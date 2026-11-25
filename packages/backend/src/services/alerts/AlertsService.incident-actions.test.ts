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
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import type { AlertIncidentActor } from "./AlertIncidentAckService"
import { type AlertsServiceApi, QUIET_AFTER_RESOLVE_CEILING_MS } from "./AlertsService"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminGrants,
	alertServices,
	asOrgId,
	asUserId,
	createWebhookDestination,
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
			body:
				body instanceof Uint8Array
					? new TextDecoder().decode(body)
					: typeof body === "string"
						? body
						: "",
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
			adminGrants,
			new WebhookAlertDestinationConfig({
				type: "webhook",
				name: "team",
				enabled: true,
				url: "https://example.com/team",
				signingSecret: "team-secret",
			}),
		)
		const request = (enabled: boolean) =>
			new AlertRuleUpsertRequest({
				name: "Checkout error rate",
				enabled,
				serviceNames: ["checkout"],
				signalType: "error_rate",
				comparator: "gt",
				thresholds: [critical(team.id)],
				windowMinutes: 5,
				minimumSampleCount: 10,
				consecutiveBreachesRequired: 2,
				consecutiveHealthyRequired: 2,
				renotifyIntervalMinutes: 60,
			})
		const rule = yield* alerts.createRule(orgId, userId, adminGrants, request(true))
		yield* ticks(alerts, 2)
		const [incident] = (yield* alerts.listIncidents(orgId)).incidents
		if (incident === undefined) return yield* Effect.die("expected an open incident")
		const setEnabled = (enabled: boolean) =>
			alerts.updateRule(orgId, userId, adminGrants, rule.id, request(enabled))
		return { ...incident, ruleId: rule.id, setEnabled }
	})

const statuses = (alerts: AlertsServiceApi, orgId: OrgId) =>
	Effect.map(alerts.listIncidents(orgId), (list) => Arr.map(list.incidents, (row) => row.status))

describe("AlertsService manual resolve", () => {
	const dana: AlertIncidentActor = { userId: asUserId("user_dana"), name: "Dana Kim", source: "web" }

	it.effect(
		"closes the incident, sends an all-clear that says who resolved it, and refuses a second resolve",
		() => {
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
				assert.isTrue(
					Str.includes("Resolved by Dana Kim")(allClear._tag === "Some" ? allClear.value.body : ""),
				)

				const again = yield* Effect.flip(alerts.resolveIncident(orgId, incident.id, dana))
				assert.strictEqual(again._tag, "@maple/http/errors/AlertIncidentResolvedError")
				const elsewhere = yield* Effect.flip(
					alerts.resolveIncident(asOrgId("org_manual_resolve_other"), incident.id, dana),
				)
				assert.strictEqual(elsewhere._tag, "@maple/http/errors/AlertIncidentNotFoundError")
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) }),
				),
			)
		},
	)

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
	/** Resolved by hand while breaching, then `after` runs and the breach is back for two checks. */
	const reopensAfter = (
		orgName: string,
		after: (
			alerts: Effect.Success<typeof alertServices>,
			incident: Effect.Success<ReturnType<typeof firing>>,
			state: { tracesAggregateRows: ReadonlyArray<Record<string, unknown>> },
		) => Effect.Effect<unknown, unknown>,
	) => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const orgId = asOrgId(orgName)
			const incident = yield* firing(alerts, orgId, asUserId(`user_${orgName}`))
			yield* alerts.resolveIncident(orgId, incident.id, dana)
			yield* ticks(alerts, 3)
			assert.deepStrictEqual(yield* statuses(alerts, orgId), ["resolved"])

			yield* after(alerts, incident, state)
			state.tracesAggregateRows = errorRateRows(10)
			yield* ticks(alerts, 3)
			assert.sameMembers(yield* statuses(alerts, orgId), ["resolved", "open"])
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch([]) })))
	}

	it.effect("opens again after the rule read no data at all, which is as well as it gets", () =>
		reopensAfter("org_manual_no_data", (alerts, _incident, state) =>
			Effect.gen(function* () {
				state.tracesAggregateRows = []
				yield* ticks(alerts, 2)
			}),
		),
	)

	it.effect("opens again after a day, however long the breach lasts", () =>
		reopensAfter("org_manual_ceiling", () =>
			TestClock.adjust(Duration.millis(QUIET_AFTER_RESOLVE_CEILING_MS)),
		),
	)

	it.effect("opens again after the rule was switched off and on", () =>
		reopensAfter("org_manual_toggled", (_alerts, incident) =>
			Effect.gen(function* () {
				yield* incident.setEnabled(false)
				yield* incident.setEnabled(true)
			}),
		),
	)

	it.effect("a group resolved by hand opens again once it left the results and came back", () => {
		const testDb = createTestDb(trackedDbs)
		const breaching = (groupName: string) =>
			tracesRow({ groupName, count: 500, errorRate: 42, estimatedSpanCount: 500 })
		const both = [breaching("checkout"), breaching("payments")]
		const state = { tracesAggregateRows: both }
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const orgId = asOrgId("org_manual_group")
			const userId = asUserId("user_manual_group")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminGrants,
				new AlertRuleUpsertRequest({
					name: "Grouped error rate",
					severity: "critical",
					enabled: true,
					groupBy: ["service.name"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 1,
					consecutiveHealthyRequired: 1,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
				}),
			)
			yield* tick(alerts)
			const paymentsStatuses = Effect.map(alerts.listIncidents(orgId), (list) =>
				Arr.map(
					Arr.filter(list.incidents, (row) => row.groupKey === "payments"),
					(row) => row.status,
				),
			)
			const [payments] = Arr.filter(
				(yield* alerts.listIncidents(orgId)).incidents,
				(row) => row.groupKey === "payments",
			)
			if (payments === undefined) return yield* Effect.die("expected a payments incident")
			yield* alerts.resolveIncident(orgId, payments.id, dana)
			yield* ticks(alerts, 2)
			assert.deepStrictEqual(yield* paymentsStatuses, ["resolved"])

			// Payments sends nothing for a while, then comes back as bad as it was.
			state.tracesAggregateRows = [breaching("checkout")]
			yield* tick(alerts)
			state.tracesAggregateRows = both
			yield* tick(alerts)
			assert.sameMembers(yield* paymentsStatuses, ["resolved", "open"])
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch([]) })))
	})

	it.effect("leaves the incident open when its all-clear cannot be prepared", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const orgId = asOrgId("org_manual_unprepared")
			const incident = yield* firing(alerts, orgId, asUserId("user_manual_unprepared"))
			// The stored rule no longer decodes, so no all-clear can be built from it.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`update alert_rules set thresholds_json = '[{"severity":"not-a-severity","value":1,"upper":null,"recoveryValue":null,"destinationIds":[]}]'::jsonb where id = $1`,
					[incident.ruleId],
				),
			)

			const refused = yield* Effect.flip(alerts.resolveIncident(orgId, incident.id, dana))
			assert.strictEqual(refused._tag, "@maple/http/errors/AlertPersistenceError")
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ status: string }>(
					testDb,
					"select status from alert_incidents where id = $1",
					[incident.id],
				),
			)
			assert.strictEqual(row?.status, "open")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch([]) })))
	})
})
