// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { AlertValidationError } from "@maple/domain/http"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Cause, Duration, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"
import { projectAlertLifecycleEvent } from "@maple/alerting-core"
import { AlertRuleUpsertRequest, OrgId, UserId } from "@maple/domain/http"
import type { WarehouseQueryServiceApi } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { AlertsService, type AlertsServiceApi, interleaveAlertRulesByOrg } from "./AlertsService"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import {
	getError,
	emptyWarehouseRows,
	tracesRow,
	makeWarehouseStub,
	DEFAULT_CLOCK_EPOCH_MS,
	makeLayer,
	asOrgId,
	asUserId,
	adminRoles,
	createWebhookDestination,
	createErrorRateRule,
	okFetch,
	insertDeliveryEventRow,
	makeUuidSequence,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

describe("interleaveAlertRulesByOrg", () => {
	it("round-robins organizations while preserving per-org order", () => {
		const rows = [
			{ orgId: "a", id: "a1" },
			{ orgId: "a", id: "a2" },
			{ orgId: "a", id: "a3" },
			{ orgId: "b", id: "b1" },
			{ orgId: "b", id: "b2" },
			{ orgId: "c", id: "c1" },
		]
		assert.deepStrictEqual(
			interleaveAlertRulesByOrg(rows).map((row) => row.id),
			["a1", "b1", "c1", "a2", "b2", "a3"],
		)
	})
})

describe("AlertsService", () => {
	it.effect("caps active alert rules per organization", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_active_rule_cap")
			const userId = asUserId("user_active_rule_cap")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const createRule = (index: number) =>
				alerts.createRule(
					orgId,
					userId,
					adminRoles,
					new AlertRuleUpsertRequest({
						name: `Capped rule ${index}`,
						severity: "warning",
						enabled: true,
						signalType: "error_rate",
						comparator: "gt",
						threshold: 5,
						windowMinutes: 5,
						destinationIds: [destination.id],
					}),
				)
			yield* Effect.forEach(
				Array.from({ length: 99 }, (_, index) => index),
				createRule,
				{ concurrency: 1, discard: true },
			)

			const exits = yield* Effect.all(
				[createRule(99).pipe(Effect.exit), createRule(100).pipe(Effect.exit)],
				{
					concurrency: "unbounded",
				},
			)
			assert.strictEqual(exits.filter(Exit.isSuccess).length, 1)
			assert.strictEqual(exits.filter(Exit.isFailure).length, 1)
			const error = getError(exits.find(Exit.isFailure)!)
			assert.instanceOf(error, AlertValidationError)
			assert.include((error as AlertValidationError).message, "at most 100 active alert rules")
			const rules = yield* alerts.listRules(orgId)
			assert.lengthOf(
				rules.rules.filter((rule) => rule.enabled),
				100,
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
	})

	it.effect("opens an incident after consecutive breaches and delivers the webhook notification", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
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
			],
		}
		const requests: Array<{ url: string; headers: Headers }> = []
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
			})
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alerts")
			const userId = asUserId("user_alerts")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			const incidentsAfterFirstTick = yield* alerts.listIncidents(orgId)

			// Advance past the scheduler lock TTL so the rule can be claimed again.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const incidentsAfterSecondTick = yield* alerts.listIncidents(orgId)
			const retrievedIncident = yield* alerts.getIncident(
				orgId,
				incidentsAfterSecondTick.incidents[0]!.id,
			)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.lengthOf(incidentsAfterFirstTick.incidents, 0)
			assert.lengthOf(incidentsAfterSecondTick.incidents, 1)
			assert.strictEqual(incidentsAfterSecondTick.incidents[0]?.status, "open")
			assert.strictEqual(retrievedIncident.id, incidentsAfterSecondTick.incidents[0]?.id)
			assert.lengthOf(events.events, 1)
			assert.strictEqual(events.events[0]?.status, "success")
			assert.strictEqual(events.events[0]?.eventType, "trigger")
			assert.lengthOf(requests, 1)
			assert.strictEqual(requests[0]?.url, "https://example.com/maple-alerts")
			assert.isNotEmpty(requests[0]?.headers.get("x-maple-signature") ?? "")
			assert.strictEqual(requests[0]?.headers.get("x-maple-event-type"), "trigger")
			assert.strictEqual(
				requests[0]?.headers.get("x-maple-delivery-key"),
				events.events[0]?.deliveryKey,
			)
			assert.notStrictEqual(
				requests[0]?.headers.get("x-maple-delivery-key"),
				incidentsAfterSecondTick.incidents[0]?.dedupeKey,
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })))
	})

	it.effect("never opens an incident whose trigger delivery could not be queued", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
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
			],
		}
		const requests: Array<string> = []
		const fetchImpl = (async (input: RequestInfo | URL) => {
			requests.push(String(input))
			return new Response("ok", { status: 200 })
		}) as typeof fetch
		const sql = (statement: string) => Effect.promise(() => executeSql(testDb, statement))

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alerts_outbox")
			const userId = asUserId("user_alerts_outbox")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			// The tick that opens the incident cannot queue its delivery.
			yield* sql(
				"CREATE FUNCTION refuse_delivery() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'delivery insert refused'; END $$ LANGUAGE plpgsql",
			)
			yield* sql(
				"CREATE TRIGGER refuse_delivery BEFORE INSERT ON alert_delivery_events FOR EACH ROW EXECUTE FUNCTION refuse_delivery()",
			)
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)

			yield* sql("DROP TRIGGER refuse_delivery ON alert_delivery_events")
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)
			assert.strictEqual(incidents.incidents[0]?.status, "open")
			assert.deepStrictEqual(
				events.events.map((event) => [event.eventType, event.status]),
				[["trigger", "success"]],
			)
			assert.deepStrictEqual(requests, ["https://example.com/maple-alerts"])
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })))
	})

	it.effect("a rule disabled while a tick evaluates it neither opens an incident nor pages", () => {
		const testDb = createTestDb(trackedDbs)
		const base = makeWarehouseStub({
			tracesAggregateRows: [
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
			],
		})
		// Runs before the next warehouse read, once; set when the edit should land.
		let beforeQuery: Effect.Effect<void> = Effect.void
		const hooked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.suspend(() => {
				const hook = beforeQuery
				beforeQuery = Effect.void
				return Effect.andThen(hook, effect)
			})
		const stub: WarehouseQueryServiceApi = {
			...base,
			sqlQuery: (...args) => hooked(base.sqlQuery(...args)),
			rawSqlQuery: (...args) => hooked(base.rawSqlQuery(...args)),
			compiledQuery: (...args) => hooked(base.compiledQuery(...args)),
			compiledQueryWithCapabilities: (...args) => hooked(base.compiledQueryWithCapabilities(...args)),
			compiledQueryFirst: (...args) => hooked(base.compiledQueryFirst(...args)),
		}
		const requests: Array<string> = []
		const fetchImpl = (async (input: RequestInfo | URL) => {
			requests.push(String(input))
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alerts_edit_fence")
			const userId = asUserId("user_alerts_edit_fence")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			// The tick that would open the incident reads the warehouse after
			// claiming the rule; the rule is disabled in between. The claim is then
			// put back at this tick's time, as a tick still holding the pre-edit
			// snapshot would when it claims the rule afresh.
			const tickAt = DEFAULT_CLOCK_EPOCH_MS + 60_000
			beforeQuery = alerts
				.updateRule(
					orgId,
					userId,
					adminRoles,
					rule.id,
					new AlertRuleUpsertRequest({
						name: rule.name,
						severity: "critical",
						enabled: false,
						serviceNames: ["checkout"],
						signalType: "error_rate",
						comparator: "gt",
						threshold: 5,
						windowMinutes: 5,
						minimumSampleCount: 10,
						consecutiveBreachesRequired: 2,
						consecutiveHealthyRequired: 2,
						renotifyIntervalMinutes: 30,
						destinationIds: [destination.id],
					}),
				)
				.pipe(
					Effect.orDie,
					Effect.andThen(
						Effect.promise(() =>
							executeSql(
								testDb,
								"insert into alert_rule_claims (rule_id, org_id, last_scheduled_at) values ($1, $2, $3) on conflict (rule_id) do update set last_scheduled_at = excluded.last_scheduled_at",
								[rule.id, orgId, new Date(tickAt).toISOString()],
							),
						),
					),
					Effect.asVoid,
				)
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
			assert.lengthOf((yield* alerts.listDeliveryEvents(orgId)).events, 0)
			assert.deepStrictEqual(requests, [])
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: fetchImpl })))
	})

	it.effect("snapshots a custom notification template into the delivered payload", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
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
			],
		}
		const bodies: string[] = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(typeof init?.body === "string" ? init.body : "")
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_tpl")
			const userId = asUserId("user_tpl")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Checkout error rate",
					severity: "critical",
					enabled: true,
					serviceNames: ["checkout"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
					notificationTemplate: {
						title: "{{ severity }} on {{ rule.name }}",
						body: "*Observed:* {{ observed.summary }}",
					},
				}),
			)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			// The custom template is re-read from the rule and surfaces through
			// get_alert_rule / listRules.
			const rules = yield* alerts.listRules(orgId)
			assert.strictEqual(
				rules.rules[0]?.notificationTemplate?.title,
				"{{ severity }} on {{ rule.name }}",
			)

			// The webhook body is the snapshotted delivery payload — it carries the
			// template so retries and downstream consumers render the same message.
			assert.lengthOf(bodies, 1)
			const payload = JSON.parse(bodies[0]!) as {
				template?: { title?: string; body?: string }
			}
			assert.strictEqual(payload.template?.title, "{{ severity }} on {{ rule.name }}")
			assert.strictEqual(payload.template?.body, "*Observed:* {{ observed.summary }}")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })))
	})

	it.effect("links the delivered payload to the incident's own page", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
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
			],
		}
		const bodies: string[] = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(typeof init?.body === "string" ? init.body : "")
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_link")
			const userId = asUserId("user_link")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.lengthOf(bodies, 1)
			const payload = JSON.parse(bodies[0]!) as { linkUrl?: string }
			assert.isTrue(
				payload.linkUrl?.endsWith(`/alerts/incidents/${incidents.incidents[0]!.id}`),
				payload.linkUrl,
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })))
	})

	it.effect("skips no-data error-rate rules instead of opening incidents", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: emptyWarehouseRows,
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_skipped")
			const userId = asUserId("user_skipped")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.lengthOf(incidents.incidents, 0)
			assert.lengthOf(events.events, 0)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state))))
	})

	it.effect("treats no data as a breach for throughput-below-threshold rules", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: emptyWarehouseRows,
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_throughput")
			const userId = asUserId("user_throughput")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Zero throughput",
					severity: "warning",
					enabled: true,
					serviceNames: ["checkout"],
					signalType: "throughput",
					comparator: "lt",
					threshold: 1,
					windowMinutes: 5,
					minimumSampleCount: 0,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
				}),
			)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.status, "open")
			assert.strictEqual(incidents.incidents[0]?.signalType, "throughput")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("persists compiled query plans when rules are created", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_compiled_plan")
			const userId = asUserId("user_compiled_plan")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					querySpecJson: unknown
					reducer: string
					sampleCountStrategy: string
					noDataBehavior: string
				}>(
					testDb,
					`
        select query_spec_json as "querySpecJson", reducer, sample_count_strategy as "sampleCountStrategy", no_data_behavior as "noDataBehavior"
        from alert_rules
        limit 1
      `,
				),
			)

			assert.isOk(row)
			assert.strictEqual(row?.reducer, "identity")
			assert.strictEqual(row?.sampleCountStrategy, "trace_count")
			assert.strictEqual(row?.noDataBehavior, "skip")
			const spec = row?.querySpecJson as {
				kind: string
				source: string
				metric: string
				groupBy: ReadonlyArray<string>
				filters: { serviceName: string }
			}
			assert.strictEqual(spec.kind, "timeseries")
			assert.strictEqual(spec.source, "traces")
			assert.strictEqual(spec.metric, "error_rate")
			assert.deepStrictEqual(spec.groupBy, ["none"])
			assert.strictEqual(spec.filters.serviceName, "checkout")
			// No environment scope selected → the filter must be absent entirely, not
			// an empty array (which the CH lowering would still treat as "no rows").
			assert.isUndefined((spec.filters as { environments?: unknown }).environments)
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("holds the scheduler claim outside alert_rules and heartbeats the rule row", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_claim_lock")
			const userId = asUserId("user_claim_lock")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			const claimAt = () =>
				Effect.promise(() =>
					queryFirstRow<{ lastScheduledAt: Date | null }>(
						testDb,
						`select last_scheduled_at as "lastScheduledAt" from alert_rule_claims limit 1`,
					),
				)
			const ruleScheduledAt = () =>
				Effect.promise(() =>
					queryFirstRow<{ lastScheduledAt: Date | null }>(
						testDb,
						`select last_scheduled_at as "lastScheduledAt" from alert_rules limit 1`,
					),
				)

			yield* alerts.runSchedulerTick()
			const claimFirst = yield* claimAt()
			const ruleFirst = yield* ruleScheduledAt()

			// One minute on: the claim must advance (it is the actual per-tick lock)
			// while alert_rules must NOT, because it is Electric-synced and every write
			// to it is replicated out of PlanetScale. That divergence is the whole point
			// of splitting the lock out — if these two move together, the WAL churn the
			// split was meant to remove is back.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const claimSecond = yield* claimAt()
			const ruleSecond = yield* ruleScheduledAt()

			// Past the 5-minute heartbeat the rule row catches up, so the column stays
			// meaningful for the API and the web diagnosis panel.
			yield* TestClock.adjust(Duration.minutes(6))
			yield* alerts.runSchedulerTick()
			const ruleThird = yield* ruleScheduledAt()

			assert.isOk(claimFirst?.lastScheduledAt, "claim row is created on the first tick")
			assert.isAbove(
				claimSecond!.lastScheduledAt!.getTime(),
				claimFirst!.lastScheduledAt!.getTime(),
				"claim advances every tick",
			)
			assert.strictEqual(
				ruleSecond?.lastScheduledAt?.getTime(),
				ruleFirst?.lastScheduledAt?.getTime(),
				"alert_rules is not rewritten inside the heartbeat window",
			)
			assert.isAbove(
				ruleThird!.lastScheduledAt!.getTime(),
				ruleFirst!.lastScheduledAt!.getTime(),
				"alert_rules catches up once the heartbeat window elapses",
			)
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	// Rules are claimed a chunk at a time in ONE multi-row INSERT, so the whole
	// batch rides on `setWhere` gating each row independently. If it ever gated the
	// statement instead, one rule already held by another worker would either drag
	// its whole chunk down or — worse — hand every rule in the chunk a claim it did
	// not win, and two workers would evaluate the same rules concurrently.
	it.effect("claims only the unheld rules when a chunk contains one another worker holds", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_batch_claim")
			const userId = asUserId("user_batch_claim")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const ruleA = yield* createErrorRateRule(alerts, orgId, userId, destination.id, "rule A")
			const ruleHeld = yield* createErrorRateRule(alerts, orgId, userId, destination.id, "rule held")
			const ruleC = yield* createErrorRateRule(alerts, orgId, userId, destination.id, "rule C")

			// Another worker took this one moments ago: inside SCHEDULER_LOCK_TTL_MS,
			// so this tick must lose it and leave its timestamp untouched.
			const heldAt = new Date(DEFAULT_CLOCK_EPOCH_MS - 1_000)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`insert into alert_rule_claims (rule_id, org_id, last_scheduled_at) values ($1, $2, $3)`,
					[ruleHeld.id, orgId, heldAt],
				),
			)

			yield* alerts.runSchedulerTick()

			const claimFor = (ruleId: string) =>
				Effect.promise(() =>
					queryFirstRow<{ lastScheduledAt: Date | null }>(
						testDb,
						`select last_scheduled_at as "lastScheduledAt" from alert_rule_claims where rule_id = $1`,
						[ruleId],
					),
				)

			const claimA = yield* claimFor(ruleA.id)
			const claimHeld = yield* claimFor(ruleHeld.id)
			const claimC = yield* claimFor(ruleC.id)

			// The two free rules are claimed by this tick...
			assert.strictEqual(
				claimA?.lastScheduledAt?.getTime(),
				DEFAULT_CLOCK_EPOCH_MS,
				"an unheld rule in the batch is claimed",
			)
			assert.strictEqual(
				claimC?.lastScheduledAt?.getTime(),
				DEFAULT_CLOCK_EPOCH_MS,
				"every unheld rule in the batch is claimed, not just the first",
			)
			// ...while the held one keeps the other worker's timestamp exactly.
			assert.strictEqual(
				claimHeld?.lastScheduledAt?.getTime(),
				heldAt.getTime(),
				"a rule held inside the lock TTL is not stolen by the batch",
			)
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("lowers the environment scope into a built-in signal's compiled plan", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_env_scope")
			const userId = asUserId("user_env_scope")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Checkout error rate (prod)",
					severity: "critical",
					serviceNames: ["checkout"],
					// Duplicates and whitespace are normalized away on write.
					environments: ["production", " staging ", "production"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					destinationIds: [destination.id],
				}),
			)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{ querySpecJson: unknown; environmentsJson: unknown }>(
					testDb,
					`select query_spec_json as "querySpecJson", environments_json as "environmentsJson"
					 from alert_rules limit 1`,
				),
			)

			assert.deepStrictEqual(row?.environmentsJson, ["production", "staging"])
			const spec = row?.querySpecJson as { filters: { environments: ReadonlyArray<string> } }
			assert.deepStrictEqual(spec.filters.environments, ["production", "staging"])

			const rules = yield* alerts.listRules(orgId)
			assert.deepStrictEqual([...(rules.rules[0]?.environments ?? [])], ["production", "staging"])
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("drops the environment scope for builder_query rules", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_env_builder")
			const userId = asUserId("user_env_builder")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			// A builder_query draft already expresses environment in its where clause;
			// a second rule-level predicate would silently AND onto the user's query.
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Custom query",
					severity: "warning",
					environments: ["production"],
					signalType: "builder_query",
					queryBuilderDraft: {
						id: "alert-query",
						name: "A",
						dataSource: "traces",
						aggregation: "count",
						whereClause: "",
						groupBy: [],
					},
					comparator: "gt",
					threshold: 10,
					windowMinutes: 5,
					destinationIds: [destination.id],
				}),
			)

			assert.deepStrictEqual([...rule.environments], [])
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("resolves an open incident after consecutive healthy evaluations", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
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
			] as ReadonlyArray<Record<string, unknown>>,
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_resolve")
			const userId = asUserId("user_resolve")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			state.tracesAggregateRows = [
				tracesRow({
					count: 200,
					avgDuration: 20,
					p50Duration: 10,
					p95Duration: 80,
					p99Duration: 160,
					errorRate: 0.5,
					satisfiedCount: 195,
					toleratingCount: 3,
					apdexScore: 0.9825,
				}),
			]

			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.status, "resolved")
			assert.deepStrictEqual(
				events.events.map((event: { eventType: string }) => event.eventType),
				["resolve", "trigger"],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	describe("severity tiers", () => {
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

		const createTieredSetup = (alerts: AlertsServiceApi, orgId: OrgId, userId: UserId) =>
			Effect.gen(function* () {
				const warnHook = yield* alerts.createDestination(orgId, userId, adminRoles, {
					type: "webhook",
					name: "Team channel",
					enabled: true,
					url: "https://example.com/warn",
					signingSecret: "warn-secret",
				})
				const pageHook = yield* alerts.createDestination(orgId, userId, adminRoles, {
					type: "webhook",
					name: "Pager",
					enabled: true,
					url: "https://example.com/page",
					signingSecret: "page-secret",
				})
				const rule = yield* alerts.createRule(
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
								destinationIds: [pageHook.id],
							},
							{
								severity: "warning",
								value: 5,
								upper: null,
								recoveryValue: null,
								destinationIds: [warnHook.id],
							},
						],
						windowMinutes: 5,
						minimumSampleCount: 10,
						consecutiveBreachesRequired: 2,
						consecutiveHealthyRequired: 2,
						renotifyIntervalMinutes: 30,
					}),
				)
				return { warnHook, pageHook, rule }
			})

		it.effect("opens at warning, pages on escalation, and resolves to everyone it notified", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
			const requests: Array<{ url: string; eventType: string | null }> = []
			const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push({
					url: String(input),
					eventType: new Headers(init?.headers).get("x-maple-event-type"),
				})
				return new Response("ok", { status: 200 })
			}) as typeof fetch

			const tick = (alerts: AlertsServiceApi) =>
				Effect.gen(function* () {
					yield* TestClock.adjust(Duration.minutes(1))
					yield* alerts.runSchedulerTick()
				})

			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers")
				const userId = asUserId("user_tiers")
				const { rule } = yield* createTieredSetup(alerts, orgId, userId)

				// Stored lowest tier first; the single-threshold fields mirror it.
				assert.deepStrictEqual(
					rule.thresholds.map((tier) => tier.severity),
					["warning", "critical"],
				)
				assert.strictEqual(rule.severity, "critical")
				assert.strictEqual(rule.threshold, 5)

				yield* alerts.runSchedulerTick()
				yield* tick(alerts)
				const opened = (yield* alerts.listIncidents(orgId)).incidents[0]
				assert.strictEqual(opened?.severity, "warning")
				assert.deepStrictEqual(requests, [{ url: "https://example.com/warn", eventType: "trigger" }])

				state.tracesAggregateRows = errorRateRows(30)
				yield* tick(alerts)
				yield* tick(alerts)
				const escalated = (yield* alerts.listIncidents(orgId)).incidents[0]
				assert.strictEqual(escalated?.id, opened?.id)
				assert.strictEqual(escalated?.severity, "critical")
				assert.strictEqual(escalated?.peakSeverity, "critical")
				assert.strictEqual(escalated?.threshold, 20)
				// The linked issue follows the escalation while the detector owns its severity.
				const issues = yield* Effect.promise(() =>
					testDb.pglite.query<{ severity: string }>(
						"select severity from error_issues where org_id = $1 and kind = 'alert'",
						[orgId],
					),
				)
				assert.deepStrictEqual(
					issues.rows.map((issue) => issue.severity),
					["critical"],
				)
				assert.sameMembers(
					requests.slice(1).map((request) => `${request.eventType} ${request.url}`),
					["trigger https://example.com/warn", "trigger https://example.com/page"],
				)

				state.tracesAggregateRows = errorRateRows(0.5)
				yield* tick(alerts)
				yield* tick(alerts)
				const resolved = (yield* alerts.listIncidents(orgId)).incidents[0]
				assert.strictEqual(resolved?.status, "resolved")
				assert.sameMembers(
					requests.slice(3).map((request) => `${request.eventType} ${request.url}`),
					["resolve https://example.com/warn", "resolve https://example.com/page"],
				)
			}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })))
		})

		const recordingFetch = (requests: Array<string>) =>
			(async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(`${new Headers(init?.headers).get("x-maple-event-type")} ${String(input)}`)
				return new Response("ok", { status: 200 })
			}) as typeof fetch

		it.effect("reminds only the current tier after a de-escalation", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(30) as ReadonlyArray<Record<string, unknown>> }
			const requests: Array<string> = []
			const tick = (alerts: AlertsServiceApi, minutes = 1) =>
				Effect.gen(function* () {
					yield* TestClock.adjust(Duration.minutes(minutes))
					yield* alerts.runSchedulerTick()
				})

			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_remind")
				yield* createTieredSetup(alerts, orgId, asUserId("user_tiers_remind"))

				yield* alerts.runSchedulerTick()
				yield* tick(alerts)
				assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.severity, "critical")

				state.tracesAggregateRows = errorRateRows(10)
				yield* tick(alerts)
				yield* tick(alerts)
				const deescalated = (yield* alerts.listIncidents(orgId)).incidents[0]
				assert.strictEqual(deescalated?.severity, "warning")
				assert.strictEqual(deescalated?.peakSeverity, "critical")
				// The pager that heard the critical hears it calm down.
				assert.sameMembers(requests.slice(2), [
					"renotify https://example.com/warn",
					"renotify https://example.com/page",
				])

				yield* tick(alerts, 31)
				assert.deepStrictEqual(requests.slice(4), ["renotify https://example.com/warn"])
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) }),
				),
			)
		})

		it.effect("resolves a warning incident ended by a rule edit without paging", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
			const requests: Array<string> = []

			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_edit")
				const userId = asUserId("user_tiers_edit")
				const { rule } = yield* createTieredSetup(alerts, orgId, userId)

				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
				assert.deepStrictEqual(requests, ["trigger https://example.com/warn"])

				yield* alerts.updateRule(
					orgId,
					userId,
					adminRoles,
					rule.id,
					new AlertRuleUpsertRequest({
						name: rule.name,
						enabled: false,
						serviceNames: [...rule.serviceNames],
						signalType: rule.signalType,
						comparator: rule.comparator,
						thresholds: rule.thresholds,
						windowMinutes: rule.windowMinutes,
						minimumSampleCount: rule.minimumSampleCount,
						consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
						consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
						renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
					}),
				)
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
				assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "resolved")
				assert.deepStrictEqual(requests.slice(1), ["resolve https://example.com/warn"])
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) }),
				),
			)
		})

		it.effect("resolves to the remaining tier after the incident's tier is removed", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
			const requests: Array<string> = []
			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_removed")
				const userId = asUserId("user_tiers_removed")
				const { rule, pageHook } = yield* createTieredSetup(alerts, orgId, userId)
				const tick = Effect.gen(function* () {
					yield* TestClock.adjust(Duration.minutes(1))
					yield* alerts.runSchedulerTick()
				})

				yield* alerts.runSchedulerTick()
				yield* tick
				assert.deepStrictEqual(requests, ["trigger https://example.com/warn"])

				yield* alerts.updateRule(
					orgId,
					userId,
					adminRoles,
					rule.id,
					new AlertRuleUpsertRequest({
						name: rule.name,
						serviceNames: [...rule.serviceNames],
						signalType: rule.signalType,
						comparator: rule.comparator,
						thresholds: [
							{
								severity: "critical",
								value: 20,
								upper: null,
								recoveryValue: null,
								destinationIds: [pageHook.id],
							},
						],
						windowMinutes: rule.windowMinutes,
						minimumSampleCount: rule.minimumSampleCount,
						consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
						consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
						renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
					}),
				)
				state.tracesAggregateRows = errorRateRows(0.5)
				yield* tick
				yield* tick
				assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "resolved")
				// The remaining tier's pager, and the webhook that heard the trigger.
				assert.sameMembers(requests.slice(1), [
					"resolve https://example.com/page",
					"resolve https://example.com/warn",
				])
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) }),
				),
			)
		})

		it.effect("resolves to a destination an edit removed after it was paged", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(30) as ReadonlyArray<Record<string, unknown>> }
			const requests: Array<string> = []

			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_removed_dest")
				const userId = asUserId("user_tiers_removed_dest")
				const { rule, warnHook } = yield* createTieredSetup(alerts, orgId, userId)

				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
				assert.sameMembers(requests, [
					"trigger https://example.com/warn",
					"trigger https://example.com/page",
				])

				// Same condition, but the critical tier no longer pages the pager.
				yield* alerts.updateRule(
					orgId,
					userId,
					adminRoles,
					rule.id,
					new AlertRuleUpsertRequest({
						name: rule.name,
						enabled: true,
						serviceNames: [...rule.serviceNames],
						signalType: rule.signalType,
						comparator: rule.comparator,
						thresholds: [
							rule.thresholds[0],
							{ ...rule.thresholds[1]!, destinationIds: [warnHook.id] },
						],
						windowMinutes: rule.windowMinutes,
						minimumSampleCount: rule.minimumSampleCount,
						consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
						consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
						renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
					}),
				)

				state.tracesAggregateRows = errorRateRows(0.5)
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
				assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "resolved")
				assert.include(requests, "resolve https://example.com/page")
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) }),
				),
			)
		})

		it.effect("keeps counting ticks across an edit that leaves the condition alone", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_rename")
				const userId = asUserId("user_tiers_rename")
				const { rule } = yield* createTieredSetup(alerts, orgId, userId)

				yield* alerts.runSchedulerTick()
				yield* alerts.updateRule(
					orgId,
					userId,
					adminRoles,
					rule.id,
					new AlertRuleUpsertRequest({
						name: "Renamed",
						serviceNames: [...rule.serviceNames],
						signalType: rule.signalType,
						comparator: rule.comparator,
						thresholds: rule.thresholds,
						windowMinutes: rule.windowMinutes,
						minimumSampleCount: rule.minimumSampleCount,
						consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
						consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
						renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
					}),
				)
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
				// The breach before the rename still counts: two in a row open the incident.
				assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.severity, "warning")
			}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
		})

		it.effect("does not count ticks judged against an edited threshold", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_edit_history")
				const userId = asUserId("user_tiers_edit_history")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const request = (value: number) =>
					new AlertRuleUpsertRequest({
						name: "Two of five",
						serviceNames: ["checkout"],
						signalType: "error_rate",
						comparator: "gt",
						thresholds: [
							{
								severity: "warning",
								value,
								upper: null,
								recoveryValue: null,
								destinationIds: [destination.id],
							},
						],
						windowMinutes: 5,
						minimumSampleCount: 10,
						consecutiveBreachesRequired: 2,
						breachesOutOf: 5,
					})
				const rule = yield* alerts.createRule(orgId, userId, adminRoles, request(5))
				const tick = Effect.gen(function* () {
					yield* TestClock.adjust(Duration.minutes(1))
					yield* alerts.runSchedulerTick()
				})

				// One breach, then a healthy tick, both against the old threshold of 5.
				yield* alerts.runSchedulerTick()
				state.tracesAggregateRows = errorRateRows(1)
				yield* tick
				yield* alerts.updateRule(orgId, userId, adminRoles, rule.id, request(15))

				// A single breach of the new threshold is one of five, not two.
				state.tracesAggregateRows = errorRateRows(30)
				yield* tick
				assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
				yield* tick
				assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 1)
			}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
		})

		it.effect(
			"records the critical tier's threshold on the issue of an incident that opens at critical",
			() => {
				const testDb = createTestDb(trackedDbs)
				const state = {
					tracesAggregateRows: errorRateRows(30) as ReadonlyArray<Record<string, unknown>>,
				}
				return Effect.gen(function* () {
					yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
					const alerts = yield* AlertsService
					const orgId = asOrgId("org_tiers_issue")
					yield* createTieredSetup(alerts, orgId, asUserId("user_tiers_issue"))

					yield* alerts.runSchedulerTick()
					yield* TestClock.adjust(Duration.minutes(1))
					yield* alerts.runSchedulerTick()

					const incident = (yield* alerts.listIncidents(orgId)).incidents[0]
					assert.strictEqual(incident?.severity, "critical")
					assert.strictEqual(incident?.threshold, 20)
					const issue = yield* Effect.promise(() =>
						queryFirstRow<{ exception_message: string }>(
							testDb,
							"select exception_message from error_issues where org_id = $1 and kind = 'alert'",
							[orgId],
						),
					)
					assert.include(issue?.exception_message ?? "", "gt 20")
				}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
			},
		)

		it.effect("rejects a critical threshold that is not worse than the warning one", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_invalid")
				const userId = asUserId("user_tiers_invalid")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const exit = yield* alerts
					.createRule(
						orgId,
						userId,
						adminRoles,
						new AlertRuleUpsertRequest({
							name: "Inverted tiers",
							signalType: "error_rate",
							comparator: "gt",
							thresholds: [
								{
									severity: "warning",
									value: 20,
									upper: null,
									recoveryValue: 25,
									destinationIds: [destination.id],
								},
								{
									severity: "critical",
									value: 5,
									upper: null,
									recoveryValue: null,
									destinationIds: [destination.id],
								},
							],
							windowMinutes: 5,
						}),
					)
					.pipe(Effect.exit)
				assert.isTrue(Exit.isFailure(exit))
				const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null
				assert.instanceOf(error, AlertValidationError)
				assert.includeMembers(error instanceof AlertValidationError ? [...error.details] : [], [
					"the critical threshold must be worse than the warning threshold",
					"thresholds[0].recoveryValue must be on the healthy side of thresholds[0].value",
				])
			}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: [] }))))
		})
	})

	it.effect("suppresses trigger and resolve notifications while an incident flaps", () => {
		const testDb = createTestDb(trackedDbs)
		const breachedRows = [
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
		] as ReadonlyArray<Record<string, unknown>>
		const healthyRows = [
			tracesRow({
				count: 200,
				avgDuration: 20,
				p50Duration: 10,
				p95Duration: 80,
				p99Duration: 160,
				errorRate: 0.5,
				satisfiedCount: 195,
				toleratingCount: 3,
				apdexScore: 0.9825,
			}),
		] as ReadonlyArray<Record<string, unknown>>
		const state = { tracesAggregateRows: breachedRows }

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_flap")
			const userId = asUserId("user_flap")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			const tick = Effect.gen(function* () {
				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
			})

			// Flap 1: open (trigger delivered) then resolve (resolve delivered).
			yield* tick
			yield* tick
			state.tracesAggregateRows = healthyRows
			yield* tick
			yield* tick

			// Flap 2 within the renotify interval: incident opens again, but both
			// its trigger and its resolve notifications are suppressed.
			state.tracesAggregateRows = breachedRows
			yield* tick
			yield* tick
			state.tracesAggregateRows = healthyRows
			yield* tick
			yield* tick

			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.lengthOf(incidents.incidents, 2)
			assert.isTrue(incidents.incidents.every((incident) => incident.status === "resolved"))
			// Only the first flap emailed: one trigger + one resolve, nothing for flap 2.
			assert.deepStrictEqual(
				events.events.map((event: { eventType: string }) => event.eventType).sort(),
				["resolve", "trigger"],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("disabling a rule does not announce the all-clear of a flap-suppressed incident", () => {
		const testDb = createTestDb(trackedDbs)
		const row = (errorRate: number) =>
			tracesRow({
				count: 200,
				avgDuration: 20,
				p50Duration: 10,
				p95Duration: 80,
				p99Duration: 160,
				errorRate,
				satisfiedCount: 190,
				toleratingCount: 5,
				apdexScore: 0.96,
			})
		const state = { tracesAggregateRows: [row(10)] as ReadonlyArray<Record<string, unknown>> }

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_flap_disable")
			const userId = asUserId("user_flap_disable")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			const ticks = (errorRate: number) =>
				Effect.sync(() => {
					state.tracesAggregateRows = [row(errorRate)]
				}).pipe(
					Effect.andThen(alerts.runSchedulerTick()),
					Effect.andThen(TestClock.adjust(Duration.minutes(1))),
					Effect.repeat({ times: 1 }),
				)

			// Flap 1 is announced; flap 2 reopens inside the renotify interval, so
			// its trigger is suppressed. Disabling the rule then resolves it.
			yield* ticks(10)
			yield* ticks(0.5)
			yield* ticks(10)
			yield* alerts.updateRule(
				orgId,
				userId,
				adminRoles,
				rule.id,
				new AlertRuleUpsertRequest({
					name: "Checkout error rate",
					severity: "critical",
					enabled: false,
					serviceNames: ["checkout"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
				}),
			)

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 2)
			assert.isTrue(incidents.incidents.every((incident) => incident.status === "resolved"))
			const events = yield* alerts.listDeliveryEvents(orgId)
			assert.deepStrictEqual(
				events.events.map((event: { eventType: string }) => event.eventType).sort(),
				["resolve", "trigger"],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("queues at most one renotify per interval while deliveries keep failing", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
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
			] as ReadonlyArray<Record<string, unknown>>,
		}
		const failingFetch: typeof fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_renotify_gate")
			const userId = asUserId("user_renotify_gate")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Checkout error rate",
					severity: "critical",
					enabled: true,
					serviceNames: ["checkout"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 5,
					destinationIds: [destination.id],
				}),
			)

			// Trigger opens on the second tick; every delivery attempt fails with a
			// retryable 500 for the whole test, so lastNotifiedAt can only advance
			// via the queue-time gate.
			for (let minute = 0; minute < 9; minute += 1) {
				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
			}

			const events = yield* alerts.listDeliveryEvents(orgId)
			const renotifyFirstAttempts = events.events.filter(
				(event: { eventType: string; attemptNumber: number }) =>
					event.eventType === "renotify" && event.attemptNumber === 1,
			)
			// Trigger at t=1min → renotify due at t=6min. Ticks at 7/8 min must NOT
			// re-queue a fresh renotify chain even though nothing was delivered.
			assert.lengthOf(renotifyFirstAttempts, 1)

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.isNotNull(incidents.incidents[0]?.lastNotifiedAt)

			// One interval after the queue-time advance, a second renotify chain starts.
			for (let minute = 0; minute < 3; minute += 1) {
				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
			}
			const eventsAfter = yield* alerts.listDeliveryEvents(orgId)
			const renotifyChains = new Set(
				eventsAfter.events
					.filter((event: { eventType: string }) => event.eventType === "renotify")
					.map((event: { deliveryKey: string }) => event.deliveryKey.split(":").at(-1)),
			)
			assert.strictEqual(renotifyChains.size, 2)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: failingFetch })))
	})

	it.effect("skips unchanged alert_rule_states writes and refreshes on the 5-minute heartbeat", () => {
		const testDb = createTestDb(trackedDbs)
		// Healthy from the start: errorRate 1 stays below the threshold of 5.
		const state = {
			tracesAggregateRows: [
				tracesRow({
					count: 200,
					avgDuration: 20,
					p50Duration: 10,
					p95Duration: 80,
					p99Duration: 160,
					errorRate: 1,
					satisfiedCount: 195,
					toleratingCount: 3,
					apdexScore: 0.9825,
				}),
			] as ReadonlyArray<Record<string, unknown>>,
		}

		const readState = (ruleId: string) =>
			Effect.promise(() =>
				queryFirstRow<{
					consecutive_healthy: number
					consecutive_breaches: number
					last_status: string | null
					last_evaluated_at: Date | string
					updated_at: Date | string
				}>(
					testDb,
					`select consecutive_healthy, consecutive_breaches, last_status, last_evaluated_at, updated_at
					 from alert_rule_states where rule_id = $1 and group_key = '__total__'`,
					[ruleId],
				),
			)
		const ms = (value: Date | string | undefined) => new Date(value ?? 0).getTime()

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_state_quiet")
			const userId = asUserId("user_state_quiet")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			// Tick 1 (T+0): healthy=1 → writes. Tick 2 (T+1m): healthy=2 (capped at
			// consecutiveHealthyRequired) → writes.
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const afterSecondTick = yield* readState(rule.id)
			assert.strictEqual(afterSecondTick?.consecutive_healthy, 2)
			assert.strictEqual(afterSecondTick?.last_status, "healthy")
			assert.strictEqual(ms(afterSecondTick?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 60_000)

			// Ticks at T+2m..T+5m: state unchanged and within the heartbeat window
			// (last write T+1m) → the upsert is skipped, the row stays byte-identical.
			for (let i = 0; i < 4; i++) {
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
			}
			const afterQuietTicks = yield* readState(rule.id)
			assert.strictEqual(afterQuietTicks?.consecutive_healthy, 2)
			assert.strictEqual(ms(afterQuietTicks?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 60_000)
			assert.strictEqual(ms(afterQuietTicks?.updated_at), DEFAULT_CLOCK_EPOCH_MS + 60_000)

			// Tick at T+6m: 5 minutes since the last write → heartbeat refreshes
			// last_evaluated_at without changing the state.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const afterHeartbeat = yield* readState(rule.id)
			assert.strictEqual(afterHeartbeat?.consecutive_healthy, 2)
			assert.strictEqual(afterHeartbeat?.last_status, "healthy")
			assert.strictEqual(ms(afterHeartbeat?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 6 * 60_000)

			// A transition writes immediately, even right after a heartbeat write:
			// flip the warehouse to breaching and tick at T+7m.
			state.tracesAggregateRows = [
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
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const afterBreach = yield* readState(rule.id)
			assert.strictEqual(afterBreach?.last_status, "breached")
			assert.strictEqual(afterBreach?.consecutive_breaches, 1)
			assert.strictEqual(afterBreach?.consecutive_healthy, 0)
			assert.strictEqual(ms(afterBreach?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 7 * 60_000)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("caps the breach counter during an open incident while the incident row keeps updating", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
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
			] as ReadonlyArray<Record<string, unknown>>,
		}

		const ms = (value: Date | string | undefined) => new Date(value ?? 0).getTime()

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_state_cap")
			const userId = asUserId("user_state_cap")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			// Two breach ticks open the incident (consecutiveBreachesRequired: 2).
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			// Two more breach ticks: the counter saturates at 2, so the state row goes
			// quiet while the incident row keeps tracking the ongoing breach.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const stateRow = yield* Effect.promise(() =>
				queryFirstRow<{ consecutive_breaches: number; updated_at: Date | string }>(
					testDb,
					`select consecutive_breaches, updated_at from alert_rule_states
					 where rule_id = $1 and group_key = '__total__'`,
					[rule.id],
				),
			)
			assert.strictEqual(stateRow?.consecutive_breaches, 2)
			// Last state write was the tick that reached the cap (T+1m).
			assert.strictEqual(ms(stateRow?.updated_at), DEFAULT_CLOCK_EPOCH_MS + 60_000)

			const incidentRow = yield* Effect.promise(() =>
				queryFirstRow<{ status: string; last_evaluated_at: Date | string }>(
					testDb,
					`select status, last_evaluated_at from alert_incidents where rule_id = $1`,
					[rule.id],
				),
			)
			assert.strictEqual(incidentRow?.status, "open")
			assert.strictEqual(ms(incidentRow?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 3 * 60_000)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("sends signed webhook test notifications", () => {
		const testDb = createTestDb(trackedDbs)
		const requests: Array<{ headers: Headers; body: string }> = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				headers: new Headers(init?.headers),
				body: String(init?.body ?? ""),
			})
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_test_destination")
			const userId = asUserId("user_test_destination")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const response = yield* alerts.testDestination(orgId, userId, adminRoles, destination.id)

			assert.isTrue(response.success)
			assert.lengthOf(requests, 1)
			assert.strictEqual(requests[0]?.headers.get("x-maple-event-type"), "test")
			assert.isNotEmpty(requests[0]?.headers.get("x-maple-signature") ?? "")
			assert.include(requests[0]?.body ?? "", '"eventType":"test"')
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	it.effect("keeps processing queued deliveries when a rule evaluation fails", () => {
		const fixedTime = 1_710_000_000_000
		const testDb = createTestDb(trackedDbs)
		const requests: Array<{ headers: Headers }> = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ headers: new Headers(init?.headers) })
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			// Pin the clock to fixedTime so the pre-seeded delivery (scheduledAt: fixedTime - 1) is due.
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_eval_failure")
			const userId = asUserId("user_eval_failure")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", [
					"{}",
					rule.id,
				]),
			)

			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000101",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
					deliveryKey: "manual-delivery-key",
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime - 1,
					payloadJson: JSON.stringify({
						eventType: "test",
						incidentId: null,
						incidentStatus: "resolved",
						dedupeKey: "manual-dedupe-key",
						rule: {
							id: rule.id,
							name: rule.name,
							signalType: rule.signalType,
							severity: rule.severity,
							groupKey: null,
							comparator: rule.comparator,
							threshold: rule.threshold,
							windowMinutes: rule.windowMinutes,
						},
						observed: {
							value: 0,
							sampleCount: 0,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
					}),
				}),
			)

			const tick = yield* alerts.runSchedulerTick()
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.strictEqual(tick.evaluationFailureCount, 1)
			assert.strictEqual(tick.processedCount, 1)
			assert.strictEqual(tick.deliveryFailureCount, 0)
			assert.lengthOf(requests, 1)
			assert.strictEqual(events.events[0]?.status, "success")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	/**
	 * A `retry: "never"` failure is not retried for its own delivery, but before
	 * this nothing bounded the DESTINATION: a webhook whose provider answers 400
	 * forever kept receiving every new incident, failing, and losing the alert
	 * silently (observed in prod as a flat ~4/hr `AlertDeliveryRejectedError`).
	 */
	describe("destination auto-disable on repeated terminal failures", () => {
		const seedDeliveryFor = (
			testDb: TestDb,
			orgId: string,
			ruleId: string,
			destinationId: string,
			scheduledAt: number,
			n: number,
		) =>
			Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: `00000000-0000-4000-8000-00000000020${n}`,
					orgId,
					incidentId: null,
					ruleId,
					destinationId,
					deliveryKey: `dead-destination-${n}`,
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt,
					payloadJson: JSON.stringify({
						eventType: "test",
						incidentId: null,
						incidentStatus: "resolved",
						dedupeKey: `dead-destination-${n}`,
						observed: { value: 0, sampleCount: 0 },
					}),
				}),
			)

		/** Break the rule's stored query so the tick's evaluation half queues nothing of its own. */
		const breakRuleQuery = (testDb: TestDb, ruleId: string) =>
			Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", [
					"{}",
					ruleId,
				]),
			)

		const readDestinationHealth = (testDb: TestDb, destinationId: string) =>
			Effect.promise(() =>
				queryFirstRow<{
					enabled: boolean
					consecutiveFailures: number
					disabledAt: Date | null
					disabledReason: string | null
				}>(
					testDb,
					`select enabled,
					        consecutive_failures as "consecutiveFailures",
					        disabled_at as "disabledAt",
					        disabled_reason as "disabledReason"
					 from alert_destinations where id = $1`,
					[destinationId],
				),
			)

		it.effect("disables the destination after three terminal failures and then skips it", () => {
			const fixedTime = 1_710_000_200_000
			const testDb = createTestDb(trackedDbs)
			let requestCount = 0
			// An empty-bodied 400, the shape a rejecting webhook returns.
			const rejectingFetch = (async () => {
				requestCount += 1
				return new Response("", { status: 400, headers: { "content-type": "application/json" } })
			}) as typeof fetch

			return Effect.gen(function* () {
				yield* TestClock.setTime(fixedTime)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_dest_disable")
				const userId = asUserId("user_dest_disable")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				yield* breakRuleQuery(testDb, rule.id)

				for (const n of [1, 2, 3]) {
					yield* seedDeliveryFor(testDb, orgId, rule.id, destination.id, fixedTime - 1, n)
				}
				yield* alerts.runSchedulerTick()

				assert.strictEqual(requestCount, 3)
				const health = yield* readDestinationHealth(testDb, destination.id)
				assert.strictEqual(health?.enabled, false)
				assert.strictEqual(health?.consecutiveFailures, 3)
				assert.isNotNull(health?.disabledAt ?? null)
				assert.include(health?.disabledReason ?? "", "delivery failed with 400")
				// The provider sent no body; the reason says so instead of trailing off.
				assert.include(health?.disabledReason ?? "", "<empty body>")

				// A delivery queued afterwards never reaches the provider again.
				yield* seedDeliveryFor(testDb, orgId, rule.id, destination.id, fixedTime - 1, 4)
				yield* alerts.runSchedulerTick()
				assert.strictEqual(requestCount, 3)

				const events = yield* alerts.listDeliveryEvents(orgId)
				const skipped = events.events.find(
					(event: { deliveryKey: string }) => event.deliveryKey === "dead-destination-4",
				)
				assert.strictEqual(skipped?.status, "failed")
				assert.strictEqual(skipped?.errorMessage, "Destination disabled")
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
						fetch: rejectingFetch,
					}),
				),
			)
		})

		it.effect("never disables a destination over Maple's own delivery faults", () => {
			const fixedTime = 1_710_000_250_000
			const testDb = createTestDb(trackedDbs)
			let requestCount = 0
			const countingFetch = (async () => {
				requestCount += 1
				return new Response("ok", { status: 200 })
			}) as typeof fetch

			return Effect.gen(function* () {
				yield* TestClock.setTime(fixedTime)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_dest_platform_fault")
				const userId = asUserId("user_dest_platform_fault")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				yield* breakRuleQuery(testDb, rule.id)
				// A secret that no longer decrypts, as after a bad key rotation.
				yield* Effect.promise(() =>
					executeSql(testDb, "update alert_destinations set secret_tag = $1 where id = $2", [
						Buffer.alloc(16, 7).toString("base64"),
						destination.id,
					]),
				)

				yield* Effect.forEach([1, 2, 3], (n) =>
					seedDeliveryFor(testDb, orgId, rule.id, destination.id, fixedTime - 1, n),
				)
				yield* alerts.runSchedulerTick()

				assert.strictEqual(requestCount, 0)
				const events = yield* alerts.listDeliveryEvents(orgId)
				assert.isTrue(events.events.every((event: { status: string }) => event.status === "failed"))
				const health = yield* readDestinationHealth(testDb, destination.id)
				assert.strictEqual(health?.enabled, true)
				assert.strictEqual(health?.consecutiveFailures, 0)
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
						fetch: countingFetch,
					}),
				),
			)
		})

		it.effect("resets the streak on a successful delivery", () => {
			const fixedTime = 1_710_000_300_000
			const testDb = createTestDb(trackedDbs)
			let reject = true
			const flakyFetch = (async () =>
				reject
					? new Response("", { status: 400 })
					: new Response("ok", { status: 200 })) as typeof fetch

			return Effect.gen(function* () {
				yield* TestClock.setTime(fixedTime)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_dest_reset")
				const userId = asUserId("user_dest_reset")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				yield* breakRuleQuery(testDb, rule.id)

				// Two terminal failures — one short of the threshold.
				for (const n of [1, 2]) {
					yield* seedDeliveryFor(testDb, orgId, rule.id, destination.id, fixedTime - 1, n)
				}
				yield* alerts.runSchedulerTick()

				const afterFailures = yield* readDestinationHealth(testDb, destination.id)
				assert.strictEqual(afterFailures?.enabled, true)
				assert.strictEqual(afterFailures?.consecutiveFailures, 2)

				// One delivery gets through: the destination is alive, so the streak
				// is over and the next terminal failure starts counting from zero.
				reject = false
				yield* seedDeliveryFor(testDb, orgId, rule.id, destination.id, fixedTime - 1, 3)
				yield* alerts.runSchedulerTick()

				const afterSuccess = yield* readDestinationHealth(testDb, destination.id)
				assert.strictEqual(afterSuccess?.enabled, true)
				assert.strictEqual(afterSuccess?.consecutiveFailures, 0)
				assert.isNull(afterSuccess?.disabledAt ?? null)
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
						fetch: flakyFetch,
					}),
				),
			)
		})
	})

	it.effect("suppresses duplicate delivery sends across concurrent service instances", () => {
		const fixedTime = 1_710_000_100_000
		const testDb = createTestDb(trackedDbs)
		let requestCount = 0
		const fetchImpl = (async () => {
			requestCount += 1
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		const stub = makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows })
		const overrides = { fetch: fetchImpl }

		return Effect.gen(function* () {
			// One shared TestClock pinned to fixedTime backs every service instance below.
			yield* TestClock.setTime(fixedTime)
			const setup = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_dupe_guard")
				const userId = asUserId("user_dupe_guard")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				return { orgId, destination, rule }
			}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))

			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", [
					"{}",
					setup.rule.id,
				]),
			)

			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000102",
					orgId: setup.orgId,
					incidentId: null,
					ruleId: setup.rule.id,
					destinationId: setup.destination.id,
					deliveryKey: "shared-delivery-key",
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime - 1,
					payloadJson: JSON.stringify({
						eventType: "test",
						incidentId: null,
						incidentStatus: "resolved",
						dedupeKey: "shared-dedupe-key",
						rule: {
							id: setup.rule.id,
							name: setup.rule.name,
							signalType: setup.rule.signalType,
							severity: setup.rule.severity,
							groupKey: null,
							comparator: setup.rule.comparator,
							threshold: setup.rule.threshold,
							windowMinutes: setup.rule.windowMinutes,
						},
						observed: {
							value: 0,
							sampleCount: 0,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
					}),
				}),
			)

			// Two independent service instances race to claim the same queued delivery;
			// the DB-level claim lease must let exactly one of them send it.
			const runTick = Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.runSchedulerTick()
			}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))

			const [tickA, tickB] = yield* Effect.all([runTick, runTick], {
				concurrency: "unbounded",
			})

			const events = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.listDeliveryEvents(setup.orgId)
			}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))

			assert.strictEqual(requestCount, 1)
			assert.strictEqual(tickA.processedCount + tickB.processedCount, 1)
			assert.strictEqual(
				events.events.find((event) => event.deliveryKey === "shared-delivery-key")?.status,
				"success",
			)
		})
	})

	it.effect("skips duplicate delivery events and still creates the incident", () => {
		const fixedTime = 1_710_000_200_000
		const testDb = createTestDb(trackedDbs)

		const state = {
			tracesAggregateRows: [
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
			],
		}
		const overrides = {
			...makeUuidSequence(
				"00000000-0000-4000-8000-000000000001",
				"00000000-0000-4000-8000-000000000002",
				"00000000-0000-4000-8000-000000000003",
				"00000000-0000-4000-8000-000000000004",
				"00000000-0000-4000-8000-000000000005",
			),
			fetch: okFetch,
		}
		const layer = makeLayer(testDb, makeWarehouseStub(state), overrides)

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_tx_rollback")
			const userId = asUserId("user_tx_rollback")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Immediate trigger",
					severity: "critical",
					enabled: true,
					serviceNames: ["checkout"],
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
			// Pre-insert a conflicting delivery event with the same delivery key
			// that processEvaluation will generate. With onConflictDoNothing(),
			// the duplicate insert is silently skipped and the incident is still created.
			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000099",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
					deliveryKey: `${"00000000-0000-4000-8000-000000000004"}:${destination.id}:trigger:${fixedTime}`,
					eventType: "trigger",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime + 60_000,
					payloadJson: JSON.stringify({
						eventType: "trigger",
						incidentId: null,
						incidentStatus: "resolved",
						dedupeKey: "conflict-dedupe",
						rule: {
							id: rule.id,
							name: rule.name,
							signalType: rule.signalType,
							severity: rule.severity,
							groupKey: null,
							comparator: rule.comparator,
							threshold: rule.threshold,
							windowMinutes: rule.windowMinutes,
						},
						observed: {
							value: 10,
							sampleCount: 200,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
					}),
				}),
			)

			const tick = yield* alerts.runSchedulerTick()
			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.strictEqual(tick.evaluationFailureCount, 0)
			assert.lengthOf(incidents.incidents, 1)
			// Only the pre-existing event — the duplicate was silently skipped
			assert.lengthOf(events.events, 1)
			assert.include(events.events[0]?.deliveryKey ?? "", ":trigger:")
		}).pipe(Effect.provide(layer))
	})

	/**
	 * The delivery queue decides whether to re-enqueue from `error.error.retryable`,
	 * which comes from the failure class's policy. Every delivery failure used to
	 * be one `AlertDeliveryError` carrying `retry: "backoff"`, so a destination
	 * whose credentials had been revoked was retried the full
	 * `MAX_DELIVERY_ATTEMPTS` against a provider that would never accept it.
	 * These two cases are the guard on that split.
	 */
	const deliveryRetryCase = (
		label: string,
		status: number,
		expectRetry: boolean,
		expectedMessage: string,
	) =>
		it.effect(label, () => {
			const fixedTime = 1_710_000_400_000
			const testDb = createTestDb(trackedDbs)
			const respond = (async () => new Response("nope", { status })) as typeof fetch

			return Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId(`org_retry_${status}`)
				const userId = asUserId(`user_retry_${status}`)
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				const deliveryKey = `retry-${status}-key`

				yield* Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-${String(status).padStart(12, "0")}`,
						orgId,
						incidentId: null,
						ruleId: rule.id,
						destinationId: destination.id,
						deliveryKey,
						eventType: "test",
						attemptNumber: 1,
						status: "queued",
						scheduledAt: fixedTime - 1,
						payloadJson: JSON.stringify({
							eventType: "test",
							incidentId: null,
							incidentStatus: "resolved",
							dedupeKey: `retry-${status}-dedupe`,
							rule: {
								id: rule.id,
								name: rule.name,
								signalType: rule.signalType,
								severity: rule.severity,
								groupKey: null,
								comparator: rule.comparator,
								threshold: rule.threshold,
								windowMinutes: rule.windowMinutes,
							},
							observed: { value: 0, sampleCount: 0 },
							linkUrl: "http://127.0.0.1:3471/alerts",
							sentAt: new Date(fixedTime).toISOString(),
						}),
					}),
				)

				const tick = yield* alerts.runSchedulerTick()
				const events = yield* alerts.listDeliveryEvents(orgId)

				assert.strictEqual(tick.deliveryFailureCount, 1)
				const firstAttempt = events.events.find(
					(event) => event.deliveryKey === deliveryKey && event.attemptNumber === 1,
				)
				const retryAttempt = events.events.find(
					(event) => event.deliveryKey === deliveryKey && event.attemptNumber === 2,
				)
				assert.strictEqual(firstAttempt?.status, "failed")
				assert.include(firstAttempt?.errorMessage ?? "", expectedMessage)
				if (expectRetry) {
					assert.strictEqual(retryAttempt?.status, "queued", "a transient failure must retry")
				} else {
					assert.isUndefined(retryAttempt, "a terminal failure must not enqueue another attempt")
				}
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
						now: Effect.succeed(fixedTime),
						fetch: respond,
					}),
				),
			)
		})

	deliveryRetryCase(
		"does not retry a destination that rejected our credentials",
		401,
		false,
		"Webhook delivery failed with 401",
	)
	deliveryRetryCase(
		"retries a destination that is temporarily unavailable",
		503,
		true,
		"Webhook delivery failed with 503",
	)

	it.live("times out stuck deliveries and enqueues a retry attempt", () => {
		const fixedTime = 1_710_000_300_000
		const testDb = createTestDb(trackedDbs)
		const hangingFetch = (() => new Promise(() => {})) as typeof fetch

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_timeout")
			const userId = asUserId("user_timeout")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			const lifecycleEvent = yield* Effect.fromResult(
				projectAlertLifecycleEvent({
					tenantId: orgId,
					ruleId: rule.id,
					ruleName: rule.name,
					incidentId: null,
					eventType: "test",
					incidentStatus: "resolved",
					groupKey: null,
					signalType: rule.signalType,
					severity: rule.severity,
					comparator: rule.comparator,
					threshold: rule.threshold,
					thresholdUpper: rule.thresholdUpper,
					windowMinutes: rule.windowMinutes,
					value: 0,
					sampleCount: 0,
					occurredAtMs: fixedTime,
				}),
			)

			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000103",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
					deliveryKey: "timeout-delivery-key",
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime - 1,
					payloadJson: JSON.stringify({
						event: lifecycleEvent,
						eventType: "test",
						incidentId: null,
						incidentStatus: "resolved",
						dedupeKey: "timeout-dedupe-key",
						rule: {
							id: rule.id,
							name: rule.name,
							signalType: rule.signalType,
							severity: rule.severity,
							groupKey: null,
							comparator: rule.comparator,
							threshold: rule.threshold,
							windowMinutes: rule.windowMinutes,
						},
						observed: {
							value: 0,
							sampleCount: 0,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
						futureAdditiveField: { preserve: true },
					}),
				}),
			)

			// The dispatch wraps the hanging fetch in a 10ms timeout driven by the
			// live runtime clock, so the timeout fires on its own in real time.
			const tick = yield* alerts.runSchedulerTick()
			const events = yield* alerts.listDeliveryEvents(orgId)
			const retryPayload = yield* Effect.promise(() =>
				queryFirstRow<{
					payload_json: {
						event?: unknown
						futureAdditiveField?: unknown
					}
				}>(
					testDb,
					"select payload_json from alert_delivery_events where delivery_key = $1 and attempt_number = 2",
					["timeout-delivery-key"],
				),
			)

			assert.strictEqual(tick.processedCount, 1)
			assert.strictEqual(tick.deliveryFailureCount, 1)
			const timeoutEvent = events.events.find(
				(event) => event.deliveryKey === "timeout-delivery-key" && event.attemptNumber === 1,
			)
			const retryEvent = events.events.find(
				(event) => event.deliveryKey === "timeout-delivery-key" && event.attemptNumber === 2,
			)
			assert.strictEqual(timeoutEvent?.status, "failed")
			assert.include(timeoutEvent?.errorMessage ?? "", "timed out")
			assert.strictEqual(retryEvent?.status, "queued")
			assert.deepStrictEqual(retryPayload?.payload_json.event, lifecycleEvent)
			assert.deepStrictEqual(retryPayload?.payload_json.futureAdditiveField, { preserve: true })
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					now: Effect.succeed(fixedTime),
					fetch: hangingFetch,
					deliveryTimeoutMs: () => 10,
				}),
			),
		)
	})

	it.effect("marks corrupted queued payloads as failed without blocking later deliveries", () => {
		const fixedTime = 1_710_000_400_000
		const testDb = createTestDb(trackedDbs)
		let requestCount = 0
		const fetchImpl = (async () => {
			requestCount += 1
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_payload_isolation")
			const userId = asUserId("user_payload_isolation")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000104",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
					deliveryKey: "bad-payload-key",
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime - 2,
					// jsonb can only hold valid JSON, so "corrupted" now means a stored
					// payload that fails the delivery-payload schema decode (every field
					// is optional, so it must be present-but-mistyped).
					payloadJson: JSON.stringify({ eventType: 123 }),
				}),
			)
			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000105",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
					deliveryKey: "good-payload-key",
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime - 1,
					payloadJson: JSON.stringify({
						eventType: "test",
						incidentId: null,
						incidentStatus: "resolved",
						dedupeKey: "good-payload-dedupe",
						rule: {
							id: rule.id,
							name: rule.name,
							signalType: rule.signalType,
							severity: rule.severity,
							groupKey: null,
							comparator: rule.comparator,
							threshold: rule.threshold,
							windowMinutes: rule.windowMinutes,
						},
						observed: {
							value: 0,
							sampleCount: 0,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
					}),
				}),
			)

			const tick = yield* alerts.runSchedulerTick()
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.strictEqual(tick.processedCount, 2)
			assert.strictEqual(tick.deliveryFailureCount, 1)
			assert.strictEqual(requestCount, 1)
			assert.strictEqual(
				events.events.find((event) => event.deliveryKey === "bad-payload-key")?.status,
				"failed",
			)
			assert.strictEqual(
				events.events.find((event) => event.deliveryKey === "good-payload-key")?.status,
				"success",
			)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})
})
