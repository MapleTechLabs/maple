import { afterEach, assert, describe, it } from "@effect/vitest"
import { Clock, Duration, Effect, Exit, Layer, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import {
	AlertForbiddenError,
	AlertRuleId,
	AlertRuleUpsertRequest,
	AlertValidationError,
	AlertSilenceCreateRequest,
	AlertSilenceUpdateRequest,
	IsoDateTimeString,
	type AlertSilenceMatchers,
} from "@maple/domain/http"
import { Schema } from "effect"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AlertsService, type AlertsServiceApi } from "./AlertsService"
import { AlertSilencesService } from "./AlertSilencesService"
import { AlertIncidentAckService } from "./AlertIncidentAckService"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminRoles,
	asOrgId,
	asUserId,
	createErrorRateRule,
	createWebhookDestination,
	getError,
	makeLayer,
	makeWarehouseStub,
	memberRoles,
	tracesRow,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const iso = Schema.decodeUnknownSync(IsoDateTimeString)
const asRuleId = Schema.decodeUnknownSync(AlertRuleId)
const at = (ms: number) => iso(new Date(ms).toISOString())

const errorRateRows = (errorRate: number) => [
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

const orgId = asOrgId("org_silences")
const userId = asUserId("user_silences")

/** A breaching error-rate rule on `checkout` with one webhook, and a counter of the webhooks sent. */
const setup = () => {
	const testDb = createTestDb(trackedDbs)
	const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
	const sent: Array<string> = []
	const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		sent.push(new Headers(init?.headers).get("x-maple-event-type") ?? "")
		return new Response("ok", { status: 200 })
	}) as typeof fetch
	const layer = makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })
	return { state, sent, layer }
}

const tick = (alerts: AlertsServiceApi) =>
	Effect.gen(function* () {
		yield* TestClock.adjust(Duration.minutes(1))
		yield* alerts.runSchedulerTick()
	})

const ticks = (alerts: AlertsServiceApi, count: number) =>
	Effect.forEach(Arr.range(1, count), () => tick(alerts), { discard: true })

const silence = (matchers: AlertSilenceMatchers, minutes = 60) =>
	Effect.gen(function* () {
		const silences = yield* AlertSilencesService
		const now = yield* Clock.currentTimeMillis
		return yield* silences.create(
			orgId,
			userId,
			adminRoles,
			new AlertSilenceCreateRequest({
				reason: "deploy checkout v2.3",
				matchers,
				endsAt: at(now + minutes * 60_000),
			}),
		)
	})

const deliveries = (alerts: AlertsServiceApi) =>
	alerts
		.listDeliveryEvents(orgId)
		.pipe(
			Effect.map((page) =>
				Arr.map(Arr.reverse(page.events), (event) => `${event.eventType}:${event.status}`),
			),
		)

const createRule = (alerts: AlertsServiceApi) =>
	Effect.gen(function* () {
		const destination = yield* createWebhookDestination(alerts, orgId, userId)
		return yield* createErrorRateRule(alerts, orgId, userId, destination.id)
	})

describe("alert silences", () => {
	it.effect("holds back the trigger and records it, without pushing", () => {
		const { sent, layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createRule(alerts)
			const created = yield* silence({ services: ["checkout"] })

			yield* ticks(alerts, 2)

			const [incident] = (yield* alerts.listIncidents(orgId)).incidents
			assert.strictEqual(incident?.status, "open")
			assert.strictEqual(incident?.silenceId, created.id)
			assert.isNotNull(incident?.silencedAt)
			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:silenced"])
			assert.deepStrictEqual(sent, [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("records one held-back page per silence, not one per reminder", () => {
		const { sent, layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createRule(alerts)
			yield* silence({ services: ["checkout"] }, 120)

			// The rule renotifies every 30 minutes; 70 minutes of breach would remind twice.
			yield* ticks(alerts, 72)

			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:silenced"])
			assert.deepStrictEqual(sent, [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("sends the held-back trigger once the silence ends on a still-open incident", () => {
		const { sent, layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const silences = yield* AlertSilencesService
			yield* createRule(alerts)
			const created = yield* silence({ services: ["checkout"] })
			yield* ticks(alerts, 2)

			yield* silences.end(orgId, userId, adminRoles, created.id)
			yield* ticks(alerts, 3)

			const [incident] = (yield* alerts.listIncidents(orgId)).incidents
			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:silenced", "trigger:success"])
			assert.deepStrictEqual(sent, ["trigger"])
			assert.isNull(incident?.silencedAt)
			// The record of which silence held it back stays.
			assert.strictEqual(incident?.silenceId, created.id)
		}).pipe(Effect.provide(layer))
	})

	it.effect("sends the all-clear to whoever was paged before the silence began", () => {
		const { state, sent, layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createRule(alerts)
			yield* ticks(alerts, 2)
			yield* silence({ services: ["checkout"] })

			state.tracesAggregateRows = errorRateRows(0.5)
			yield* ticks(alerts, 2)

			assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "resolved")
			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:success", "resolve:success"])
			assert.deepStrictEqual(sent, ["trigger", "resolve"])
		}).pipe(Effect.provide(layer))
	})

	it.effect("tells nobody about the resolve of an incident nobody was paged for", () => {
		const { state, sent, layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createRule(alerts)
			yield* silence({ services: ["checkout"] })
			yield* ticks(alerts, 2)

			state.tracesAggregateRows = errorRateRows(0.5)
			yield* ticks(alerts, 2)

			assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "resolved")
			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:silenced", "resolve:silenced"])
			assert.deepStrictEqual(sent, [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("stays quiet about a resolve after the silence when the held-back page never went out", () => {
		const { state, sent, layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const silences = yield* AlertSilencesService
			yield* createRule(alerts)
			const created = yield* silence({ services: ["checkout"] })
			yield* ticks(alerts, 2)

			// Healthy from here on, so no breaching check gets to send the catch-up.
			state.tracesAggregateRows = errorRateRows(0.5)
			yield* silences.end(orgId, userId, adminRoles, created.id)
			yield* ticks(alerts, 2)

			assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "resolved")
			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:silenced", "resolve:silenced"])
			assert.deepStrictEqual(sent, [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("does not touch a rule whose scope the silence only partly covers", () => {
		const { sent, layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createRule(alerts)
			yield* silence({ services: ["payments"] })
			yield* silence({ services: ["checkout"], environments: ["staging"] })

			yield* ticks(alerts, 2)

			assert.isNull((yield* alerts.listIncidents(orgId)).incidents[0]?.silenceId ?? null)
			assert.deepStrictEqual(sent, ["trigger"])
		}).pipe(Effect.provide(layer))
	})

	it.effect("silences a rule by id until a scheduled start, then from it", () => {
		const { sent, layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const silences = yield* AlertSilencesService
			const rule = yield* createRule(alerts)
			const now = yield* Clock.currentTimeMillis
			const scheduled = yield* silences.create(
				orgId,
				userId,
				adminRoles,
				new AlertSilenceCreateRequest({
					reason: "planned migration",
					matchers: { ruleIds: [rule.id] },
					startsAt: at(now + 10 * 60_000),
					endsAt: at(now + 70 * 60_000),
				}),
			)
			assert.strictEqual(scheduled.status, "scheduled")

			yield* ticks(alerts, 2)
			assert.deepStrictEqual(sent, ["trigger"])
			assert.strictEqual((yield* silences.get(orgId, scheduled.id)).status, "scheduled")

			yield* ticks(alerts, 40)
			// In force from minute 10: the reminder due at minute 32 is held back.
			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:success", "renotify:silenced"])
			assert.deepStrictEqual(sent, ["trigger"])
		}).pipe(Effect.provide(layer))
	})
})

describe("alert silences, pages in flight and reminders", () => {
	it.effect("sends the all-clear to a destination whose pre-silence trigger is still retrying", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
		// The webhook is down for the whole test: the trigger stays queued for a retry.
		const fetchImpl = (async () => new Response("down", { status: 503 })) as typeof fetch
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createRule(alerts)
			yield* ticks(alerts, 2)
			yield* silence({ services: ["checkout"] })

			state.tracesAggregateRows = errorRateRows(0.5)
			yield* ticks(alerts, 2)

			const events = (yield* alerts.listDeliveryEvents(orgId)).events
			const resolves = Arr.filter(events, (event) => event.eventType === "resolve")
			assert.isNotEmpty(resolves)
			assert.isTrue(Arr.every(resolves, (event) => event.status !== "silenced"))
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })))
	})

	it.effect("owes a held-back reminder and sends it as a reminder once the silence ends", () => {
		const { sent, layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const silences = yield* AlertSilencesService
			yield* createRule(alerts)
			yield* ticks(alerts, 2)
			const created = yield* silence({ services: ["checkout"] }, 120)
			const before = (yield* alerts.listIncidents(orgId)).incidents[0]

			// Past the 30-minute reminder: it is held back and owed, and moves no anchor.
			yield* ticks(alerts, 35)
			const held = (yield* alerts.listIncidents(orgId)).incidents[0]
			assert.strictEqual(held?.silenceId, created.id)
			assert.isNotNull(held?.silencedAt)
			assert.strictEqual(held?.lastNotifiedAt, before?.lastNotifiedAt)

			yield* silences.end(orgId, userId, adminRoles, created.id)
			yield* ticks(alerts, 2)
			assert.deepStrictEqual(yield* deliveries(alerts), [
				"trigger:success",
				"renotify:silenced",
				"renotify:success",
			])
			assert.deepStrictEqual(sent, ["trigger", "renotify"])
			assert.isNull((yield* alerts.listIncidents(orgId)).incidents[0]?.silencedAt)
		}).pipe(Effect.provide(layer))
	})
})

describe("alert silences and acknowledgement", () => {
	it.effect("does not page an incident acknowledged during the silence once it ends", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
		const sent: Array<string> = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			sent.push(new Headers(init?.headers).get("x-maple-event-type") ?? "")
			return new Response("ok", { status: 200 })
		}) as typeof fetch
		const layer = Layer.merge(
			makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl }),
			AlertIncidentAckService.layer.pipe(Layer.provide(testDb.layer)),
		)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const silences = yield* AlertSilencesService
			const acks = yield* AlertIncidentAckService
			yield* createRule(alerts)
			const created = yield* silence({ services: ["checkout"] })
			yield* ticks(alerts, 2)
			const incident = (yield* alerts.listIncidents(orgId)).incidents[0]
			assert.isDefined(incident)
			if (incident === undefined) return
			yield* acks.acknowledge(orgId, incident.id, { userId, name: "Dana", source: "web" })

			yield* silences.end(orgId, userId, adminRoles, created.id)
			yield* ticks(alerts, 3)

			assert.deepStrictEqual(yield* deliveries(alerts), ["trigger:silenced"])
			assert.deepStrictEqual(sent, [])
			// Still owed: an escalation that clears the ack sends it then.
			assert.isNotNull((yield* alerts.listIncidents(orgId)).incidents[0]?.silencedAt)
		}).pipe(Effect.provide(layer))
	})
})

describe("alert silences, acknowledgement and escalation", () => {
	it.effect("an escalation of an acknowledged incident pages once and settles the held-back page", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
		const sent: Array<string> = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			sent.push(new Headers(init?.headers).get("x-maple-event-type") ?? "")
			return new Response("ok", { status: 200 })
		}) as typeof fetch
		const layer = Layer.merge(
			makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl }),
			AlertIncidentAckService.layer.pipe(Layer.provide(testDb.layer)),
		)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const silences = yield* AlertSilencesService
			const acks = yield* AlertIncidentAckService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Checkout error rate tiers",
					enabled: true,
					serviceNames: ["checkout"],
					signalType: "error_rate",
					comparator: "gt",
					thresholds: [
						{
							severity: "critical",
							value: 20,
							upper: null,
							recoveryValue: null,
							destinationIds: [destination.id],
						},
						{
							severity: "warning",
							value: 5,
							upper: null,
							recoveryValue: null,
							destinationIds: [destination.id],
						},
					],
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
				}),
			)
			const created = yield* silence({ services: ["checkout"] })
			yield* ticks(alerts, 2)
			const incident = (yield* alerts.listIncidents(orgId)).incidents[0]
			assert.isDefined(incident)
			if (incident === undefined) return
			yield* acks.acknowledge(orgId, incident.id, { userId, name: "Dana", source: "web" })
			yield* silences.end(orgId, userId, adminRoles, created.id)
			yield* ticks(alerts, 2)
			assert.deepStrictEqual(sent, [])

			// Worse now: the escalation pages despite the ack, and that page settles the held one.
			state.tracesAggregateRows = errorRateRows(30)
			yield* ticks(alerts, 5)

			assert.deepStrictEqual(sent, ["trigger"])
			assert.isNull((yield* alerts.listIncidents(orgId)).incidents[0]?.silencedAt)
		}).pipe(Effect.provide(layer))
	})
})

describe("AlertSilencesService", () => {
	it.effect("validates the window, the rule ids and the caller's role", () => {
		const { layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const silences = yield* AlertSilencesService
			const now = DEFAULT_CLOCK_EPOCH_MS
			const request = (endsAtMs: number, matchers: AlertSilenceMatchers = { tags: ["db"] }) =>
				new AlertSilenceCreateRequest({ reason: "maintenance", matchers, endsAt: at(endsAtMs) })

			const past = yield* Effect.exit(silences.create(orgId, userId, adminRoles, request(now - 1)))
			const tooLong = yield* Effect.exit(
				silences.create(orgId, userId, adminRoles, request(now + 31 * 24 * 60 * 60_000)),
			)
			const unknownRule = yield* Effect.exit(
				silences.create(
					orgId,
					userId,
					adminRoles,
					request(now + 60_000, { ruleIds: [asRuleId("0b8f7c1e-2f61-4f1e-9d2a-3c4b5d6e7f80")] }),
				),
			)
			const forbidden = yield* Effect.exit(
				silences.create(orgId, userId, memberRoles, request(now + 60_000)),
			)

			assert.isTrue(Exit.isFailure(past) && Schema.is(AlertValidationError)(getError(past)))
			assert.isTrue(Exit.isFailure(tooLong) && Schema.is(AlertValidationError)(getError(tooLong)))
			assert.isTrue(
				Exit.isFailure(unknownRule) && Schema.is(AlertValidationError)(getError(unknownRule)),
			)
			assert.isTrue(Exit.isFailure(forbidden) && Schema.is(AlertForbiddenError)(getError(forbidden)))
		}).pipe(Effect.provide(layer))
	})

	it.effect("extends, then ends a silence, and lists it by status", () => {
		const { layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const silences = yield* AlertSilencesService
			const created = yield* silence({ tags: ["db"] })
			const extended = yield* silences.update(
				orgId,
				userId,
				adminRoles,
				created.id,
				new AlertSilenceUpdateRequest({ endsAt: at(DEFAULT_CLOCK_EPOCH_MS + 2 * 60 * 60_000) }),
			)
			assert.strictEqual(Date.parse(extended.endsAt) - Date.parse(created.endsAt), 60 * 60_000)

			yield* TestClock.adjust(Duration.minutes(5))
			const ended = yield* silences.end(orgId, userId, adminRoles, created.id)
			assert.strictEqual(ended.status, "ended")
			assert.lengthOf((yield* silences.list(orgId, { status: "active" })).silences, 0)
			assert.deepStrictEqual(
				Arr.map((yield* silences.list(orgId, { status: "ended" })).silences, (s) => s.id),
				[created.id],
			)
		}).pipe(Effect.provide(layer))
	})
})
