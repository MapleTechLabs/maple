import {
	AlertDestinationInUseError,
	AlertRuleUpsertRequest,
	AlertSilenceCreateRequest,
	AlertValidationError,
	EscalationChainCreateRequest,
	EscalationChainId,
	EscalationChainInUseError,
	EscalationChainUpdateRequest,
	IsoDateTimeString,
	WebhookAlertDestinationConfig,
	type AlertDestinationId,
	type AlertThreshold,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Clock, Duration, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { AlertsService, type AlertsServiceApi } from "./AlertsService"
import { AlertSilencesService } from "./AlertSilencesService"
import { applyEscalationPlan, planEscalationWork, selectEscalationWork } from "./alert-escalation-runs"
import { EscalationChainsService } from "./EscalationChainsService"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminRoles,
	asOrgId,
	asUserId,
	getError,
	makeLayer,
	makeWarehouseStub,
	stubOrgMembersService,
	tracesRow,
} from "./alerts-service-test-support"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"

const decodeChainId = Schema.decodeUnknownSync(EscalationChainId)
const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)
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

/** `trigger https://example.com/slack` per webhook request, in send order. */
const recordingFetch = (requests: Array<string>) =>
	(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input)
		requests.push(
			`${new Headers(init?.headers).get("x-maple-event-type")} ${Str.replace("https://example.com/", "")(url)}`,
		)
		return new Response("ok", { status: 200 })
	}) as typeof fetch

const layerFor = (
	testDb: TestDb,
	state: { tracesAggregateRows: ReadonlyArray<Record<string, unknown>> },
	requests: Array<string>,
) =>
	Layer.mergeAll(
		makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) }),
		Layer.effect(EscalationChainsService, EscalationChainsService.make).pipe(
			Layer.provide(testDb.layer),
			Layer.provide(Layer.succeed(OrgMembersService, stubOrgMembersService())),
		),
		testDb.layer,
	)

const tick = (alerts: AlertsServiceApi, minutes = 1) =>
	Effect.gen(function* () {
		yield* TestClock.adjust(Duration.minutes(minutes))
		yield* alerts.runSchedulerTick()
	})

/** Ticks once a minute for `minutes` minutes. */
const ticks = (alerts: AlertsServiceApi, minutes: number) =>
	Effect.forEach(Arr.range(1, minutes), () => tick(alerts), { discard: true })

const webhook = (alerts: AlertsServiceApi, orgId: OrgId, userId: UserId, name: string) =>
	alerts.createDestination(
		orgId,
		userId,
		adminRoles,
		new WebhookAlertDestinationConfig({
			type: "webhook",
			name,
			enabled: true,
			url: `https://example.com/${name}`,
			signingSecret: `${name}-secret`,
		}),
	)

const ruleRequest = (thresholds: Arr.NonEmptyReadonlyArray<AlertThreshold>) =>
	new AlertRuleUpsertRequest({
		name: "Checkout error rate",
		enabled: true,
		serviceNames: ["checkout"],
		signalType: "error_rate",
		comparator: "gt",
		thresholds,
		windowMinutes: 5,
		minimumSampleCount: 10,
		consecutiveBreachesRequired: 2,
		consecutiveHealthyRequired: 2,
		renotifyIntervalMinutes: 60,
	})

const tier = (
	severity: AlertThreshold["severity"],
	value: number,
	destinationIds: ReadonlyArray<AlertDestinationId>,
	escalationChainId: EscalationChainId | null,
): AlertThreshold => ({
	severity,
	value,
	upper: null,
	recoveryValue: null,
	destinationIds,
	escalationChainId,
})

/** "#team" on the tier; the chain notifies slack, waits 10 minutes, then pages, waits 15. */
const setup = (orgName: string, options: { readonly repeatCount?: number } = {}) =>
	Effect.gen(function* () {
		const alerts = yield* AlertsService
		const chains = yield* EscalationChainsService
		const orgId = asOrgId(orgName)
		const userId = asUserId(`user_${orgName}`)
		const team = yield* webhook(alerts, orgId, userId, "team")
		const slack = yield* webhook(alerts, orgId, userId, "slack")
		const pager = yield* webhook(alerts, orgId, userId, "pager")
		const chain = yield* chains.create(
			orgId,
			userId,
			adminRoles,
			new EscalationChainCreateRequest({
				name: "API escalation",
				steps: [
					{ targets: [{ type: "destination", destinationId: slack.id }], waitMinutes: 10 },
					{ targets: [{ type: "destination", destinationId: pager.id }], waitMinutes: 15 },
				],
				...(options.repeatCount === undefined ? undefined : { repeatCount: options.repeatCount }),
			}),
		)
		const rule = yield* alerts.createRule(
			orgId,
			userId,
			adminRoles,
			ruleRequest([tier("critical", 5, [team.id], chain.id)]),
		)
		return { alerts, chains, orgId, userId, team, slack, pager, chain, rule }
	})

const runRows = (testDb: TestDb, orgId: OrgId) =>
	Effect.promise(() =>
		testDb.pglite.query<{ status: string; steps_sent: number; chain_name: string }>(
			"select status, steps_sent, chain_name from alert_escalation_runs where org_id = $1 order by created_at",
			[orgId],
		),
	).pipe(Effect.map((result) => result.rows))

const setAck = (testDb: TestDb, orgId: OrgId, acknowledged: boolean) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			acknowledged
				? `update alert_incidents set acknowledged_at = now(), acknowledged_by_name = 'Ana', acknowledged_via = 'web' where org_id = $1`
				: `update alert_incidents set acknowledged_at = null, acknowledged_by_name = null, acknowledged_via = null where org_id = $1`,
			[orgId],
		),
	)

/** Silences the `checkout` service, for an hour by default; ended early with `silences.end`. */
const silenceCheckout = (orgId: OrgId, userId: UserId, minutes = 60) =>
	Effect.gen(function* () {
		const silences = yield* AlertSilencesService
		const nowMs = yield* Clock.currentTimeMillis
		const silence = yield* silences.create(
			orgId,
			userId,
			adminRoles,
			new AlertSilenceCreateRequest({
				reason: "checkout deploy",
				matchers: { services: ["checkout"] },
				endsAt: decodeIso(new Date(nowMs + minutes * 60_000).toISOString()),
			}),
		)
		return { end: silences.end(orgId, userId, adminRoles, silence.id) }
	})

describe("escalation chains", () => {
	it.effect("pages the next step after the wait, once, and ends after the last step", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const { alerts, orgId } = yield* setup("org_esc_walk")
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			// Opened: the tier's destination and the chain's first step, in the same tick.
			assert.sameMembers(requests, ["trigger team", "trigger slack"])

			yield* ticks(alerts, 9)
			assert.lengthOf(requests, 2)
			yield* tick(alerts)
			assert.deepStrictEqual(requests.slice(2), ["trigger pager"])

			yield* ticks(alerts, 20)
			assert.lengthOf(requests, 3)
			assert.deepStrictEqual(yield* runRows(testDb, orgId), [
				{ status: "exhausted", steps_sent: 2, chain_name: "API escalation" },
			])
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("repeats the whole chain repeatCount more times", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const { alerts, orgId } = yield* setup("org_esc_repeat", { repeatCount: 1 })
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			// slack at 0, pager at 10, slack again at 25, pager at 35.
			yield* ticks(alerts, 40)
			assert.deepStrictEqual(
				Arr.filter(requests, (request) => request !== "trigger team"),
				["trigger slack", "trigger pager", "trigger slack", "trigger pager"],
			)
			assert.strictEqual((yield* runRows(testDb, orgId))[0]?.status, "exhausted")
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("stops at an acknowledgement and picks up where it was after an unacknowledge", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const { alerts, orgId } = yield* setup("org_esc_ack")
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			yield* setAck(testDb, orgId, true)
			yield* ticks(alerts, 20)
			// Nobody paged while Ana is on it.
			assert.sameMembers(requests, ["trigger team", "trigger slack"])
			assert.strictEqual((yield* runRows(testDb, orgId))[0]?.status, "acknowledged")

			yield* setAck(testDb, orgId, false)
			yield* tick(alerts)
			assert.deepStrictEqual(requests.slice(2), ["trigger pager"])
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("ends without paging once the incident resolves mid-wait", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const { alerts, orgId } = yield* setup("org_esc_resolve")
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			state.tracesAggregateRows = errorRateRows(1)
			yield* ticks(alerts, 3)
			yield* ticks(alerts, 20)
			assert.notInclude(requests, "trigger pager")
			assert.strictEqual((yield* runRows(testDb, orgId))[0]?.status, "resolved")
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("moves a step only from the position it was read at, so a second writer loses", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const { alerts } = yield* setup("org_esc_cas")
			const database = yield* Database
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			yield* ticks(alerts, 9)
			yield* TestClock.adjust(Duration.minutes(1))
			const nowMs = DEFAULT_CLOCK_EPOCH_MS + 11 * 60_000
			// Both writers read the run at the same position, as two overlapping ticks would.
			const [row] = yield* database.execute((db) => selectEscalationWork(db, nowMs))
			if (row === undefined) return assert.fail("expected a due run")
			const plan = planEscalationWork(row, false, nowMs)
			const apply = database.execute((db) =>
				db.transaction(
					applyEscalationPlan(db, {
						row,
						plan,
						nowMs,
						enabled: new Set(),
						makeDeliveryId: crypto.randomUUID.bind(crypto),
					}),
				),
			)
			assert.deepStrictEqual([yield* apply, yield* apply], ["sent", "lost"])
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("reads only runs with a decision to make, so standing acks cannot crowd out a due step", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const { alerts, orgId } = yield* setup("org_esc_starve")
			const database = yield* Database
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			yield* setAck(testDb, orgId, true)
			// Read once it falls due, and paused there.
			yield* ticks(alerts, 12)
			assert.strictEqual((yield* runRows(testDb, orgId))[0]?.status, "acknowledged")
			// Paused on a standing ack: nothing to decide, however long it has been due.
			const nowMs = DEFAULT_CLOCK_EPOCH_MS + 120 * 60_000
			assert.lengthOf(yield* database.execute((db) => selectEscalationWork(db, nowMs, 1)), 0)
			yield* setAck(testDb, orgId, false)
			assert.lengthOf(yield* database.execute((db) => selectEscalationWork(db, nowMs, 1)), 1)
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("does not send a queued step once the incident is acknowledged", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const { alerts, orgId, pager } = yield* setup("org_esc_drain")
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			// A step queued just before an ack committed, as the drain would find it.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`insert into alert_delivery_events (id, org_id, incident_id, rule_id, destination_id, delivery_key,
					   event_type, attempt_number, status, scheduled_at, payload_json, created_at, updated_at)
					 select gen_random_uuid()::text, org_id, incident_id, rule_id, $2, delivery_key || ':late', event_type, 1,
					   'queued', scheduled_at, payload_json || '{"escalation":{"step":2}}'::jsonb, created_at, updated_at
					 from alert_delivery_events where org_id = $1 limit 1`,
					[orgId, pager.id],
				),
			)
			yield* setAck(testDb, orgId, true)
			yield* tick(alerts)
			assert.notInclude(requests, "trigger pager")
			const rows = yield* Effect.promise(() =>
				testDb.pglite.query<{ status: string; error_message: string }>(
					"select status, error_message from alert_delivery_events where org_id = $1 and destination_id = $2",
					[orgId, pager.id],
				),
			)
			assert.strictEqual(rows.rows[0]?.status, "failed")
			assert.include(rows.rows[0]?.error_message ?? "", "acknowledged")
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("keeps escalating after a flap-suppressed re-open, past the step already paged", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const { alerts, orgId } = yield* setup("org_esc_flap")
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			// Resolves, then re-opens inside the reminder interval: the re-open pages nobody.
			state.tracesAggregateRows = errorRateRows(1)
			yield* ticks(alerts, 2)
			state.tracesAggregateRows = errorRateRows(10)
			yield* ticks(alerts, 2)
			assert.sameMembers(requests, ["trigger team", "trigger slack", "resolve team", "resolve slack"])
			// The chain carries on from step 2 for the new incident.
			yield* ticks(alerts, 10)
			assert.include(requests, "trigger pager")
			assert.lengthOf(
				Arr.filter(requests, (request) => request === "trigger slack"),
				1,
			)
			assert.sameMembers(
				Arr.map(yield* runRows(testDb, orgId), (row) => row.status),
				["resolved", "exhausted"],
			)
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("stops the critical tier's chain when the incident drops back to warning", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(30) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const chains = yield* EscalationChainsService
			const orgId = asOrgId("org_esc_deescalate")
			const userId = asUserId("user_esc_deescalate")
			const team = yield* webhook(alerts, orgId, userId, "team")
			const pager = yield* webhook(alerts, orgId, userId, "pager")
			const chain = yield* chains.create(
				orgId,
				userId,
				adminRoles,
				new EscalationChainCreateRequest({
					name: "Page chain",
					steps: [{ targets: [{ type: "destination", destinationId: pager.id }], waitMinutes: 10 }],
					repeatCount: 3,
				}),
			)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				ruleRequest([tier("critical", 20, [], chain.id), tier("warning", 5, [team.id], null)]),
			)
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			assert.include(requests, "trigger pager")
			state.tracesAggregateRows = errorRateRows(10)
			yield* ticks(alerts, 30)
			assert.lengthOf(
				Arr.filter(requests, (request) => request === "trigger pager"),
				1,
			)
			assert.strictEqual((yield* runRows(testDb, orgId))[0]?.status, "superseded")
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("notifies a destination in both the tier and the first step once", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const chains = yield* EscalationChainsService
			const orgId = asOrgId("org_esc_dedupe")
			const userId = asUserId("user_esc_dedupe")
			const team = yield* webhook(alerts, orgId, userId, "team")
			const chain = yield* chains.create(
				orgId,
				userId,
				adminRoles,
				new EscalationChainCreateRequest({
					name: "Team first",
					steps: [{ targets: [{ type: "destination", destinationId: team.id }], waitMinutes: 5 }],
				}),
			)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				ruleRequest([tier("critical", 5, [team.id], chain.id)]),
			)
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			assert.deepStrictEqual(requests, ["trigger team"])
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("holds a step that falls due under a silence, and sends it once the silence ends", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const { alerts, orgId, userId } = yield* setup("org_esc_silenced_step")
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			assert.sameMembers(requests, ["trigger team", "trigger slack"])
			const silence = yield* silenceCheckout(orgId, userId)
			// The pager step falls due at minute 10; the silence holds it.
			yield* ticks(alerts, 15)
			assert.lengthOf(requests, 2)
			assert.strictEqual((yield* runRows(testDb, orgId))[0]?.status, "active")

			yield* silence.end
			yield* tick(alerts)
			assert.deepStrictEqual(requests.slice(2), ["trigger pager"])
			yield* ticks(alerts, 5)
			assert.deepStrictEqual(requests.slice(2), ["trigger pager"])
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect(
		"starts the chain of an incident that opens under a silence, paging step 1 once it ends",
		() => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(10) }
			const requests: Array<string> = []
			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const { alerts, orgId, userId } = yield* setup("org_esc_opened_silenced")
				const silence = yield* silenceCheckout(orgId, userId)
				yield* alerts.runSchedulerTick()
				yield* ticks(alerts, 5)
				assert.deepStrictEqual(requests, [])
				assert.deepStrictEqual(yield* runRows(testDb, orgId), [
					{ status: "active", steps_sent: 0, chain_name: "API escalation" },
				])

				yield* silence.end
				yield* tick(alerts)
				// The tier's held-back trigger and the chain's first step, each once.
				assert.sameMembers(requests, ["trigger team", "trigger slack"])
				yield* ticks(alerts, 5)
				assert.sameMembers(requests, ["trigger team", "trigger slack"])
			}).pipe(Effect.provide(layerFor(testDb, state, requests)))
		},
	)

	it.effect("pages a destination in both the tier and the held step once when the silence ends", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const chains = yield* EscalationChainsService
			const orgId = asOrgId("org_esc_silenced_dedupe")
			const userId = asUserId("user_esc_silenced_dedupe")
			const team = yield* webhook(alerts, orgId, userId, "team")
			const chain = yield* chains.create(
				orgId,
				userId,
				adminRoles,
				new EscalationChainCreateRequest({
					name: "Team first",
					steps: [{ targets: [{ type: "destination", destinationId: team.id }], waitMinutes: 5 }],
				}),
			)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				ruleRequest([tier("critical", 5, [team.id], chain.id)]),
			)
			const silence = yield* silenceCheckout(orgId, userId)
			yield* alerts.runSchedulerTick()
			yield* ticks(alerts, 3)
			yield* silence.end
			// Off the minute: the held step fell due before the catch-up page went out.
			yield* TestClock.adjust(Duration.seconds(90))
			yield* alerts.runSchedulerTick()
			assert.deepStrictEqual(requests, ["trigger team"])
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("does not page a held step's destination again when the catch-up is a renotify", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const chains = yield* EscalationChainsService
			const orgId = asOrgId("org_esc_silenced_renotify")
			const userId = asUserId("user_esc_silenced_renotify")
			const team = yield* webhook(alerts, orgId, userId, "team")
			const step = {
				targets: [{ type: "destination" as const, destinationId: team.id }],
				waitMinutes: 5,
			}
			const chain = yield* chains.create(
				orgId,
				userId,
				adminRoles,
				new EscalationChainCreateRequest({ name: "Team twice", steps: [step, step] }),
			)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				ruleRequest([tier("critical", 5, [team.id], chain.id)]),
			)
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			assert.deepStrictEqual(requests, ["trigger team"])
			const silence = yield* silenceCheckout(orgId, userId, 120)
			// Step 2 falls due at minute 5 and the hourly reminder at 60; the silence holds both.
			yield* ticks(alerts, 62)
			assert.deepStrictEqual(requests, ["trigger team"])
			yield* silence.end
			yield* tick(alerts)
			yield* ticks(alerts, 3)
			assert.deepStrictEqual(requests, ["trigger team", "renotify team"])
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("restarts on the critical tier's own chain when a warning incident escalates", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const chains = yield* EscalationChainsService
			const orgId = asOrgId("org_esc_supersede")
			const userId = asUserId("user_esc_supersede")
			const slack = yield* webhook(alerts, orgId, userId, "slack")
			const pager = yield* webhook(alerts, orgId, userId, "pager")
			const create = (name: string, destinationId: AlertDestinationId, repeatCount: number) =>
				chains.create(
					orgId,
					userId,
					adminRoles,
					new EscalationChainCreateRequest({
						name,
						steps: [{ targets: [{ type: "destination", destinationId }], waitMinutes: 30 }],
						repeatCount,
					}),
				)
			// The warning chain is still waiting to repeat when the incident escalates.
			const warnChain = yield* create("Warn chain", slack.id, 1)
			const pageChain = yield* create("Page chain", pager.id, 0)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				ruleRequest([tier("critical", 20, [], pageChain.id), tier("warning", 5, [], warnChain.id)]),
			)
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			assert.deepStrictEqual(requests, ["trigger slack"])
			state.tracesAggregateRows = errorRateRows(30)
			yield* ticks(alerts, 2)
			assert.deepStrictEqual(requests, ["trigger slack", "trigger pager"])
			assert.deepStrictEqual(
				Arr.map(yield* runRows(testDb, orgId), (row) => [row.chain_name, row.status]),
				[
					["Warn chain", "superseded"],
					["Page chain", "exhausted"],
				],
			)
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("refuses deleting a destination a running escalation still pages from its snapshot", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const { alerts, chains, orgId, userId, slack, pager, chain } =
				yield* setup("org_esc_snapshot_guard")
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			// The chain stops naming slack, but the open incident's run still has it in its snapshot.
			yield* chains.update(
				orgId,
				userId,
				adminRoles,
				chain.id,
				new EscalationChainUpdateRequest({
					steps: [{ targets: [{ type: "destination", destinationId: pager.id }], waitMinutes: 10 }],
				}),
			)
			const refused = getError(
				yield* Effect.exit(alerts.deleteDestination(orgId, adminRoles, slack.id)),
			)
			if (!Schema.is(AlertDestinationInUseError)(refused)) return assert.fail("expected in use")
			assert.include(refused.message, "escalating an open incident")
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})

	it.effect("refuses a rule naming an unknown chain, and deleting a chain or destination in use", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const { alerts, chains, orgId, userId, team, slack, chain, rule } = yield* setup("org_esc_guards")
			const unknown = yield* Effect.exit(
				alerts.createRule(
					orgId,
					userId,
					adminRoles,
					ruleRequest([
						tier("critical", 5, [team.id], decodeChainId("00000000-0000-4000-8000-0000000000ff")),
					]),
				),
			)
			assert.instanceOf(getError(unknown), AlertValidationError)

			const inUse = getError(yield* Effect.exit(chains.delete(orgId, adminRoles, chain.id)))
			assert.instanceOf(inUse, EscalationChainInUseError)
			assert.deepStrictEqual((yield* chains.get(orgId, chain.id)).ruleIds, [rule.id])

			const destinationInUse = getError(
				yield* Effect.exit(alerts.deleteDestination(orgId, adminRoles, slack.id)),
			)
			if (!Schema.is(AlertDestinationInUseError)(destinationInUse))
				return assert.fail("expected in use")
			assert.include(destinationInUse.message, "API escalation")

			yield* alerts.deleteRule(orgId, adminRoles, rule.id)
			yield* chains.delete(orgId, adminRoles, chain.id)
			assert.lengthOf((yield* chains.list(orgId)).chains, 0)
		}).pipe(Effect.provide(layerFor(testDb, state, requests)))
	})
})
