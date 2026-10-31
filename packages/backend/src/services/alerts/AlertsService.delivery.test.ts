// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { AlertDeliveryError, AlertDeliveryRejectedError } from "@maple/domain/http"
import { ChatAlertPoster } from "./ChatAlertPoster"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Clock, Duration, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	type AlertDestinationId,
	ChatConnectorId,
	ChatWorkspaceId,
	AlertRuleUpsertRequest,
	WarehouseQueryError,
} from "@maple/domain/http"
import type { WarehouseQueryServiceApi } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { AlertsService, type AlertsServiceApi } from "./AlertsService"
import { baselineWarehouseCapabilities } from "@maple/query-engine"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { compiledQueryOf } from "@maple/query-engine/execution"
import {
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
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

describe("AlertsService delivery lease freshness", () => {
	it.effect("claims later rows with a fresh timestamp, not the batch head's", () => {
		const fixedTime = 1_710_000_400_000
		const testDb = createTestDb(trackedDbs)
		// Virtual scheduler clock: the first delivery "takes" most of the drain
		// budget, so a second claim dated from the batch-head timestamp would
		// expire mid-delivery and an overlapping tick could re-send the event.
		let virtualNow = fixedTime
		let call = 0
		let laterRowLeaseExpiry: number | null = null
		const fetchImpl = (async () => {
			call += 1
			if (call === 1) {
				virtualNow += 19_000
			} else {
				const row = await queryFirstRow<{ claimExpiresAt: Date | null }>(
					testDb,
					`select claim_expires_at as "claimExpiresAt"
					 from alert_delivery_events where delivery_key = 'lease-2'`,
					[],
				)
				laterRowLeaseExpiry = row?.claimExpiresAt?.getTime() ?? null
			}
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_lease_fresh")
			const userId = asUserId("user_lease_fresh")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			// Break the rule's stored query so the tick's evaluation half queues
			// nothing of its own.
			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", [
					"{}",
					rule.id,
				]),
			)

			for (const n of [1, 2]) {
				yield* Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-00000000030${n}`,
						orgId,
						incidentId: null,
						ruleId: rule.id,
						destinationId: destination.id,
						deliveryKey: `lease-${n}`,
						eventType: "test",
						attemptNumber: 1,
						status: "queued",
						// Row 1 first: rows are processed in scheduledAt order.
						scheduledAt: fixedTime - 10 + n,
						payloadJson: JSON.stringify({
							eventType: "test",
							incidentId: null,
							incidentStatus: "resolved",
							dedupeKey: `lease-${n}`,
							observed: { value: 0, sampleCount: 0 },
						}),
					}),
				)
			}
			yield* alerts.runSchedulerTick()

			assert.strictEqual(call, 2)
			// The second claim must be dated from its own claim time (after the
			// 19s "slow" first delivery). A batch-head lease would end at
			// fixedTime + TTL, 19s short of the one this delivery holds.
			assert.isNotNull(laterRowLeaseExpiry)
			assert.isAbove(laterRowLeaseExpiry ?? 0, fixedTime + 30_000)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
					now: Effect.sync(() => virtualNow),
				}),
			),
		)
	})
})

describe("AlertsService delivery drain across destinations", () => {
	it.effect("a slow destination costs its own rows, not another destination's page", () => {
		const fixedTime = 1_710_000_450_000
		const testDb = createTestDb(trackedDbs)
		// Virtual clock: every delivery to the slow endpoint "takes" 15s.
		let virtualNow = fixedTime
		const delivered: Array<string> = []
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = String(input)
			if (url === "https://example.com/maple-alerts") virtualNow += 15_000
			delivered.push(url)
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_drain_fairness")
			const userId = asUserId("user_drain_fairness")
			const slow = yield* createWebhookDestination(alerts, orgId, userId)
			const fast = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "webhook",
				name: "Fast webhook",
				enabled: true,
				url: "https://example.com/fast",
				signingSecret: "webhook-secret",
			})
			const rule = yield* createErrorRateRule(alerts, orgId, userId, slow.id)
			// Break the rule's stored query so the tick queues nothing of its own.
			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", [
					"{}",
					rule.id,
				]),
			)

			// Three rows for the slow endpoint, queued ahead of the fast one's.
			const queued = [
				[slow.id, "slow-1"],
				[slow.id, "slow-2"],
				[slow.id, "slow-3"],
				[fast.id, "fast-1"],
			] as const
			for (const [index, [destinationId, deliveryKey]] of queued.entries()) {
				yield* Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-00000000040${index}`,
						orgId,
						incidentId: null,
						ruleId: rule.id,
						destinationId,
						deliveryKey,
						eventType: "test",
						attemptNumber: 1,
						status: "queued",
						scheduledAt: fixedTime - 10 + index,
						payloadJson: JSON.stringify({
							eventType: "test",
							incidentId: null,
							incidentStatus: "resolved",
							dedupeKey: deliveryKey,
							observed: { value: 0, sampleCount: 0 },
						}),
					}),
				)
			}
			yield* alerts.runSchedulerTick()

			const statuses = yield* Effect.promise(() =>
				testDb.pglite.query<{ deliveryKey: string; status: string }>(
					`select delivery_key as "deliveryKey", status from alert_delivery_events order by delivery_key`,
				),
			)
			assert.include(delivered, "https://example.com/fast")
			assert.deepStrictEqual(
				statuses.rows.map((row) => [row.deliveryKey, row.status]),
				[
					["fast-1", "success"],
					["slow-1", "success"],
					["slow-2", "success"],
					// Started past the drain budget, so it waits for the next tick.
					["slow-3", "queued"],
				],
			)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
					now: Effect.sync(() => virtualNow),
				}),
			),
		)
	})
})

describe("AlertsService tick isolation", () => {
	const breachedRows = () =>
		[
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

	it.effect("a rule that crashes does not stop the other rules in the tick", () => {
		const testDb = createTestDb(trackedDbs)
		const crashingOrg = asOrgId("org_crash_rule")
		const base = makeWarehouseStub({ tracesAggregateRows: breachedRows() })
		const crashFor =
			(orgId: string) =>
			<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
				orgId === crashingOrg ? Effect.die(new Error("warehouse client bug")) : effect
		const stub: WarehouseQueryServiceApi = {
			...base,
			sqlQuery: (tenant, ...rest) => crashFor(tenant.orgId)(base.sqlQuery(tenant, ...rest)),
			rawSqlQuery: (tenant, ...rest) => crashFor(tenant.orgId)(base.rawSqlQuery(tenant, ...rest)),
			compiledQuery: (tenant, ...rest) => crashFor(tenant.orgId)(base.compiledQuery(tenant, ...rest)),
			compiledQueryWithCapabilities: (tenant, ...rest) =>
				crashFor(tenant.orgId)(base.compiledQueryWithCapabilities(tenant, ...rest)),
			compiledQueryFirst: (tenant, ...rest) =>
				crashFor(tenant.orgId)(base.compiledQueryFirst(tenant, ...rest)),
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const healthyOrg = asOrgId("org_crash_neighbour")
			const userId = asUserId("user_crash")
			// Created first, so the crashing rule is evaluated first.
			const crashing = yield* createErrorRateRule(
				alerts,
				crashingOrg,
				userId,
				(yield* createWebhookDestination(alerts, crashingOrg, userId)).id,
			)
			yield* createErrorRateRule(
				alerts,
				healthyOrg,
				userId,
				(yield* createWebhookDestination(alerts, healthyOrg, userId)).id,
			)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(healthyOrg)
			assert.strictEqual(incidents.incidents[0]?.status, "open")
			const crashed = (yield* alerts.listRules(crashingOrg)).rules.find((r) => r.id === crashing.id)
			assert.include(crashed?.lastEvaluationError ?? "", "Internal error")
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
	})

	it.effect("a delivery row that crashes is failed once and does not block the queue", () => {
		const fixedTime = 1_710_000_500_000
		const testDb = createTestDb(trackedDbs)
		const sent: string[] = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			sent.push(String(init?.body ?? ""))
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_poison_delivery")
			const userId = asUserId("user_poison_delivery")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			const insert = (n: number, eventType: string) =>
				Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-00000000040${n}`,
						orgId,
						incidentId: null,
						ruleId: rule.id,
						destinationId: destination.id,
						deliveryKey: `poison-${n}`,
						eventType,
						attemptNumber: 1,
						status: "queued",
						// The corrupt row is the oldest, so it is claimed first.
						scheduledAt: fixedTime - 10 + n,
						payloadJson: JSON.stringify({
							eventType: "test",
							incidentId: null,
							incidentStatus: "resolved",
							dedupeKey: `poison-${n}`,
							observed: { value: 0, sampleCount: 0 },
						}),
					}),
				)
			yield* insert(1, "not-an-event-type")
			yield* insert(2, "test")

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const statuses = yield* Effect.promise(() =>
				queryFirstRow<{ summary: string }>(
					testDb,
					`select string_agg(delivery_key || '=' || status, ',' order by delivery_key) as summary
					 from alert_delivery_events where delivery_key like 'poison-%'`,
					[],
				),
			)
			// Failed once with its attempt time, and not re-queued: its stored
			// event type cannot be read, so the retry insert fails too.
			assert.strictEqual(statuses?.summary, "poison-1=failed,poison-2=success")
			const poison = yield* Effect.promise(() =>
				queryFirstRow<{ attempts: number; attemptedAt: Date | null }>(
					testDb,
					`select count(*)::int as attempts, max(attempted_at) as "attemptedAt"
					 from alert_delivery_events where delivery_key = 'poison-1'`,
					[],
				),
			)
			assert.strictEqual(poison?.attempts, 1)
			assert.isNotNull(poison?.attemptedAt ?? null)
			assert.lengthOf(sent, 1)
			const destinations = yield* alerts.listDestinations(orgId)
			assert.isTrue(destinations.destinations[0]?.enabled)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})
})

describe("AlertsService delivery drain", () => {
	it.effect("drains a burst larger than one batch in a single tick", () => {
		const fixedTime = 1_710_000_600_000
		const testDb = createTestDb(trackedDbs)
		const sent = { count: 0 }
		const countingFetch = (async () => {
			sent.count += 1
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_drain_burst")
			const userId = asUserId("user_drain_burst")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			yield* Effect.forEach(Arr.range(1, 60), (n) =>
				Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-${String(500 + n).padStart(12, "0")}`,
						orgId,
						incidentId: null,
						ruleId: rule.id,
						destinationId: destination.id,
						deliveryKey: `burst-${n}`,
						eventType: "test",
						attemptNumber: 1,
						status: "queued",
						scheduledAt: fixedTime - 100 + n,
						payloadJson: JSON.stringify({
							eventType: "test",
							incidentId: null,
							incidentStatus: "resolved",
							dedupeKey: `burst-${n}`,
							observed: { value: 0, sampleCount: 0 },
						}),
					}),
				),
			)

			const tick = yield* alerts.runSchedulerTick()

			assert.strictEqual(sent.count, 60)
			assert.strictEqual(tick.processedCount, 60)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: countingFetch,
				}),
			),
		)
	})
})

describe("AlertsService chat digests", () => {
	const fixedTime = 1_710_000_900_000
	const workspaceId = Schema.decodeUnknownSync(ChatWorkspaceId)("44444444-4444-4444-8444-444444444444")

	/** Queues `count` trigger deliveries for one chat destination, runs a tick, and reads the queue. */
	const runBurst = (
		count: number,
		outcome: "posted" | "rate_limited" | "rejected",
		eventTypeOf: (n: number) => string = () => "trigger",
	) => {
		const testDb = createTestDb(trackedDbs)
		const posts: Array<string> = []
		const poster = Layer.succeed(ChatAlertPoster, {
			post: (request) =>
				Effect.suspend(() => {
					const card = request.blocks[0]
					posts.push(card?.kind === "alert" ? card.title : "")
					if (outcome === "posted")
						return Effect.succeed({
							connectorName: "Test Chat",
							messageId: `message-${posts.length}`,
						})
					const fields = {
						message: "Discord refused this message",
						destinationType: "chat" as const,
					}
					return Effect.fail(
						outcome === "rejected"
							? new AlertDeliveryRejectedError(fields)
							: new AlertDeliveryError(fields),
					)
				}),
			findChannel: () =>
				Effect.succeed({
					connector: Schema.decodeUnknownSync(ChatConnectorId)("testchat"),
					workspaceName: "Acme",
					channelName: "incidents",
				}),
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_chat_digest")
			const userId = asUserId("user_chat_digest")
			const destination = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "chat",
				name: "Incidents",
				workspaceId,
				channelId: "channel-1",
			})
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			yield* Effect.forEach(Arr.range(1, count), (n) =>
				Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`,
						orgId,
						incidentId: null,
						ruleId: rule.id,
						destinationId: destination.id,
						deliveryKey: `digest-${n}`,
						eventType: eventTypeOf(n),
						attemptNumber: 1,
						status: "queued",
						scheduledAt: fixedTime - 100 + n,
						payloadJson: JSON.stringify({
							eventType: eventTypeOf(n) === "test" ? "test" : "trigger",
							dedupeKey: `digest-${n}`,
						}),
					}),
				),
			)
			yield* alerts.runSchedulerTick()
			const queue = yield* Effect.promise(() =>
				queryFirstRow<{ summary: string }>(
					testDb,
					`select string_agg(status || '@' || attempt_number, ',' order by status, attempt_number) as summary
					 from alert_delivery_events where delivery_key like 'digest-%'`,
					[],
				),
			)
			const health = yield* Effect.promise(() =>
				queryFirstRow<{ failures: number; enabled: boolean }>(
					testDb,
					"select consecutive_failures as failures, enabled from alert_destinations where id = $1",
					[destination.id],
				),
			)
			return { posts, queue: queue?.summary ?? "", health }
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }),
					undefined,
					undefined,
					poster,
				),
			),
		)
	}

	it.effect("sends a burst of five for one channel as one digest and delivers every row", () =>
		Effect.gen(function* () {
			const { posts, queue } = yield* runBurst(5, "posted")
			assert.deepStrictEqual(posts, ["\u{1F514} 5 alert notifications"])
			assert.strictEqual(queue, Array(5).fill("success@1").join(","))
		}),
	)

	it.effect("keeps two deliveries as two ordinary messages", () =>
		Effect.gen(function* () {
			const { posts, queue } = yield* runBurst(2, "posted")
			assert.lengthOf(posts, 2)
			assert.notInclude(posts.join(","), "alert notifications")
			assert.strictEqual(queue, "success@1,success@1")
		}),
	)

	it.effect("counts a refused digest as one destination failure, not one per row", () =>
		Effect.gen(function* () {
			const { posts, queue, health } = yield* runBurst(4, "rejected")
			assert.lengthOf(posts, 1)
			assert.strictEqual(queue, Array(4).fill("failed@1").join(","))
			assert.strictEqual(health?.failures, 1)
			assert.isTrue(health?.enabled)
		}),
	)

	it.effect("finishes every row of a failed digest even when one row's recovery fails", () =>
		Effect.gen(function* () {
			// The first row's stored event type cannot be read, so its retry insert fails.
			const { queue } = yield* runBurst(4, "rate_limited", (n) =>
				n === 1 ? "not-an-event-type" : "trigger",
			)
			assert.strictEqual(queue, [...Array(4).fill("failed@1"), ...Array(3).fill("queued@2")].join(","))
		}),
	)

	it.effect("posts a digest where its first row sits in the batch, after earlier deliveries", () =>
		Effect.gen(function* () {
			const { posts } = yield* runBurst(5, "posted", (n) => (n === 1 ? "test" : "trigger"))
			assert.lengthOf(posts, 2)
			assert.notInclude(posts[0], "alert notifications")
			assert.strictEqual(posts[1], "\u{1F514} 4 alert notifications")
		}),
	)

	it.effect("leaves every row of a failed digest queued for a retry", () =>
		Effect.gen(function* () {
			const { posts, queue } = yield* runBurst(5, "rate_limited")
			assert.lengthOf(posts, 1)
			assert.strictEqual(queue, [...Array(5).fill("failed@1"), ...Array(5).fill("queued@2")].join(","))
		}),
	)
})

describe("alert incident open uniqueness", () => {
	const insertOpenIncident = (testDb: TestDb, id: string, status = "open") =>
		executeSql(
			testDb,
			`
        insert into alert_incidents (
          id, org_id, rule_id, incident_key, rule_name, group_key, signal_type,
          severity, status, comparator, threshold, first_triggered_at,
          last_triggered_at, dedupe_key, created_at, updated_at
        ) values (
          $1, 'org_unique', 'rule_unique', $1, 'Rule', 'checkout', 'error_rate',
          'critical', $2, 'gt', 5, now(), now(), 'org_unique:rule_unique:checkout',
          now(), now()
        )
      `,
			[id, status],
		)

	it.effect("rejects a second open incident for the same (rule, group)", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() => insertOpenIncident(testDb, "inc-open-1"))
			// The partial unique index is the backstop for an expired scheduler
			// claim: two overlapping ticks can both decide to open, but only one
			// row can exist.
			const second = yield* Effect.promise(() =>
				insertOpenIncident(testDb, "inc-open-2").then(
					() => "inserted" as const,
					() => "conflict" as const,
				),
			)
			assert.strictEqual(second, "conflict")

			// Resolved history does not participate: after resolving the first,
			// a new open incident for the same key is legal again.
			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_incidents set status = 'resolved' where id = $1", [
					"inc-open-1",
				]),
			)
			const third = yield* Effect.promise(() =>
				insertOpenIncident(testDb, "inc-open-3").then(
					() => "inserted" as const,
					() => "conflict" as const,
				),
			)
			assert.strictEqual(third, "inserted")
		})
	})
})

describe("AlertsService held incidents", () => {
	const DAY_MS = 24 * 60 * 60_000

	/** A `service_operations_minutely` liveness row for one probe window. */
	const livenessRow = (spanCount: number): Record<string, unknown> => ({
		minutesWithData: spanCount > 0 ? 5 : 0,
		spanCount,
		estimatedSpanCount: spanCount,
		errorCount: 0,
		estimatedErrorCount: 0,
		lastSeen: "2023-11-14 22:13:00",
	})

	/** The `startTime` literal of a compiled liveness query, as epoch ms. */
	const probeWindowStartMs = (sql: string): number | null => {
		const match = />= '(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})'/.exec(sql)
		return match?.[1] === undefined ? null : Date.parse(`${match[1].replace(" ", "T")}Z`)
	}

	/**
	 * Which of the three probe windows a start time names, and its count. The
	 * observed window is exactly one rule window (5m) back from the tick; the
	 * onset baseline ends at incident onset, which is at least a minute earlier.
	 */
	const probeCount = (liveness: LivenessState, startMs: number, service?: string): number =>
		startMs <= liveness.nowMs - 23 * 60 * 60_000
			? liveness.priorDay
			: startMs >= liveness.nowMs - 5 * 60_000 - 1_000
				? ((service === undefined ? undefined : liveness.observedByService?.[service]) ??
					liveness.observed)
				: liveness.onset

	interface LivenessState {
		/** Span count for the quiet window ending at the tick. */
		observed: number
		/** Per-service override of `observed`, for a loud sibling next to a dark service. */
		observedByService?: Record<string, number>
		/** Span count for the window ending at incident onset. */
		onset: number
		/** Span count for the same window yesterday; 0 for a service with no prior day. */
		priorDay: number
		/** Make every liveness probe fail, so the verdict is `probe_failed`. */
		failProbe: boolean
		/** The test clock, mirrored so the stub can tell the three windows apart. */
		nowMs: number
	}

	/**
	 * Routes the rule's own evaluation to `rows` and every liveness probe to the
	 * window-specific counts in `liveness`, telling the windows apart by their
	 * start time: yesterday is a day back, observed ends at the tick, and
	 * anything else is the onset baseline.
	 */
	const makeLivenessStub = (state: {
		rows: ReadonlyArray<Record<string, unknown>>
		liveness: LivenessState
	}): WarehouseQueryServiceApi => {
		const evaluationRows = () => Effect.succeed(state.rows)
		// A `serviceNames` rule evaluates one service-filtered plan per service;
		// honour that filter so a silent service really sees an empty window.
		const rowsForQuery = (sql: string) => {
			const scoped = /ServiceName (?:= '([^']+)'|IN \('([^']+)'\))/.exec(sql)
			const service = scoped?.[1] ?? scoped?.[2]
			return service === undefined ? state.rows : state.rows.filter((row) => row.groupName === service)
		}
		return {
			...makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }),
			warmRoute: () => Effect.void,
			sqlQuery: evaluationRows,
			rawSqlQuery: evaluationRows,
			compiledQuery: (_tenant, compiled) =>
				Effect.gen(function* () {
					const query = compiledQueryOf(compiled)
					// The org-wide pulse (a rule with no service scope): same counts,
					// union shape.
					if (query.sql.includes("service_overview_spans")) {
						const startMs = probeWindowStartMs(query.sql) ?? state.liveness.nowMs
						return yield* query
							.decodeRows([
								{ signal: "spans", count: probeCount(state.liveness, startMs), lastSeen: "" },
							])
							.pipe(Effect.orDie)
					}
					return yield* query.decodeRows(rowsForQuery(query.sql)).pipe(Effect.orDie)
				}),
			compiledQueryWithCapabilities: (_tenant, compile) => {
				const query = Effect.runSync(compile(baselineWarehouseCapabilities()))
				return query.decodeRows(rowsForQuery(query.sql)).pipe(Effect.orDie)
			},
			compiledQueryFirst: (_tenant, compiled) =>
				Effect.gen(function* () {
					const query = compiledQueryOf(compiled)
					if (!query.sql.includes("service_operations_minutely")) {
						return yield* query.decodeFirstRow(state.rows).pipe(Effect.orDie)
					}
					if (state.liveness.failProbe) {
						return yield* Effect.fail(
							new WarehouseQueryError({ message: "probe failed", pipeName: "liveness" }),
						)
					}
					const startMs = probeWindowStartMs(query.sql) ?? state.liveness.nowMs
					const service = /ServiceName = '([^']+)'/.exec(query.sql)?.[1]
					return yield* query
						.decodeFirstRow([livenessRow(probeCount(state.liveness, startMs, service))])
						.pipe(Effect.orDie)
				}),
		}
	}

	const breaching = (groupName: string) =>
		tracesRow({ groupName, count: 500, errorRate: 42, estimatedSpanCount: 500 })

	/**
	 * Grouped by service, both groups breaching, one incident each after a
	 * single tick. A group that drops out of the results is an orphan; a
	 * `serviceNames` rule evaluates each service on its own instead and lands
	 * in the skipped path — see the multi-service test below.
	 */
	const createTwoServiceRule = (
		alerts: AlertsServiceApi,
		orgId: ReturnType<typeof asOrgId>,
		userId: ReturnType<typeof asUserId>,
		destinationId: AlertDestinationId,
		scope: { groupBy: ["service.name"] } | { serviceNames: ["checkout", "payments"] } = {
			groupBy: ["service.name"],
		},
	) =>
		alerts.createRule(
			orgId,
			userId,
			adminRoles,
			new AlertRuleUpsertRequest({
				name: "Grouped error rate",
				severity: "critical",
				enabled: true,
				...scope,
				signalType: "error_rate",
				comparator: "gt",
				threshold: 5,
				windowMinutes: 5,
				minimumSampleCount: 10,
				consecutiveBreachesRequired: 1,
				consecutiveHealthyRequired: 1,
				renotifyIntervalMinutes: 30,
				destinationIds: [destinationId],
			}),
		)

	const tickAfter = (state: { liveness: LivenessState }, alerts: AlertsServiceApi, minutes: number) =>
		Effect.gen(function* () {
			yield* TestClock.adjust(Duration.minutes(minutes))
			state.liveness.nowMs = yield* Clock.currentTimeMillis
			yield* alerts.runSchedulerTick()
		})

	const paymentsIncident = (alerts: AlertsServiceApi, orgId: ReturnType<typeof asOrgId>) =>
		Effect.map(alerts.listIncidents(orgId), (list) => {
			const incident = list.incidents.find((i) => i.groupKey === "payments")
			assert.ok(incident, "payments incident missing")
			return incident
		})

	it.effect("holds an orphaned group whose traffic collapsed, then resolves at the ceiling", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			// Peak at onset, a thin evening now, no prior day to compare against.
			liveness: { observed: 19, onset: 172, priorDay: 0, failProbe: false, nowMs: 0 },
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_hold_ceiling")
			const userId = asUserId("user_hold_ceiling")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 2)

			// payments vanishes from the results while its traffic is at 11% of onset.
			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)

			const held = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(held.status, "open")
			assert.strictEqual(held.holdReason, "volume_collapsed")
			assert.strictEqual(held.heldSince, new Date(DEFAULT_CLOCK_EPOCH_MS + 60_000).toISOString())
			assert.strictEqual(held.resolvedAt, null)
			const eventsWhileHeld = yield* alerts.listDeliveryEvents(orgId)
			assert.deepStrictEqual(
				eventsWhileHeld.events.map((e) => e.eventType),
				["trigger", "trigger"],
				"a hold must not notify",
			)

			// Still held short of the ceiling (max(3 × 5m, 30m) = 30m): same reason,
			// same clock.
			yield* tickAfter(state, alerts, 20)
			const stillHeld = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(stillHeld.status, "open")
			assert.strictEqual(stillHeld.heldSince, held.heldSince)

			// Past the ceiling the absence is believed and the incident resolves,
			// telling the destination why.
			yield* tickAfter(state, alerts, 10)
			const resolved = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(resolved.status, "resolved")
			assert.strictEqual(resolved.holdReason, null)
			assert.strictEqual(resolved.heldSince, null)
			// One resolve, for payments; checkout's 30-minute renotify is the only
			// other event in the meantime.
			const events = yield* alerts.listDeliveryEvents(orgId)
			assert.deepStrictEqual(
				events.events.map((e) => e.eventType).filter((type) => type !== "renotify"),
				["resolve", "trigger", "trigger"],
			)

			// The still-breaching group was never touched.
			const checkout = (yield* alerts.listIncidents(orgId)).incidents.find(
				(i) => i.groupKey === "checkout",
			)
			assert.strictEqual(checkout?.status, "open")
			assert.strictEqual(checkout?.holdReason, null)
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})

	it.effect("resolves a held incident as soon as telemetry is back", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			liveness: { observed: 0, onset: 172, priorDay: 0, failProbe: false, nowMs: 0 },
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_hold_return")
			const userId = asUserId("user_hold_return")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			// The service went completely dark: an outage, held for up to six hours.
			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)
			assert.strictEqual((yield* paymentsIncident(alerts, orgId)).holdReason, "no_data")

			// Traffic returns at its usual level and the group is still absent from
			// the results: the breach really is over.
			state.liveness.observed = 170
			yield* tickAfter(state, alerts, 1)
			const resolved = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(resolved.status, "resolved")
			assert.strictEqual(resolved.holdReason, null)
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})

	it.effect("reads a nightly dip against yesterday night and resolves without a hold", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			// 19 now against 172 at onset would collapse; against 22 this hour
			// yesterday it is a normal night.
			liveness: { observed: 19, onset: 172, priorDay: 22, failProbe: false, nowMs: 0 },
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS + DAY_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS + DAY_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_hold_prior_day")
			const userId = asUserId("user_hold_prior_day")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)
			const resolved = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(resolved.status, "resolved")
			assert.strictEqual(resolved.holdReason, null)
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})

	it.effect("suppresses the resolve of an orphaned group whose trigger was flap-suppressed", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			liveness: { observed: 19, onset: 172, priorDay: 22, failProbe: false, nowMs: 0 },
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS + DAY_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS + DAY_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_orphan_flap")
			const userId = asUserId("user_orphan_flap")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			// Flap 1: the group drops out and its all-clear is delivered.
			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)
			// Flap 2 inside the renotify interval: the reopen's trigger is
			// suppressed, so its orphan resolve must stay quiet too.
			state.rows = [breaching("checkout"), breaching("payments")]
			yield* tickAfter(state, alerts, 1)
			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)

			const payments = (yield* alerts.listIncidents(orgId)).incidents.filter(
				(incident) => incident.groupKey === "payments",
			)
			assert.lengthOf(payments, 2)
			assert.isTrue(payments.every((incident) => incident.status === "resolved"))
			const events = yield* alerts.listDeliveryEvents(orgId)
			assert.deepStrictEqual(
				events.events.map((event: { eventType: string }) => event.eventType).sort(),
				["resolve", "trigger", "trigger"],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})

	it.effect("a breach ends the hold and a later hold starts a fresh clock", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			liveness: { observed: 19, onset: 172, priorDay: 0, failProbe: false, nowMs: 0 },
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_hold_rebreach")
			const userId = asUserId("user_hold_rebreach")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)
			const firstHold = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(firstHold.holdReason, "volume_collapsed")

			// The breach comes back: same incident, hold cleared, no new trigger.
			state.rows = [breaching("checkout"), breaching("payments")]
			yield* tickAfter(state, alerts, 1)
			const rebreached = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(rebreached.id, firstHold.id)
			assert.strictEqual(rebreached.status, "open")
			assert.strictEqual(rebreached.holdReason, null)
			assert.strictEqual(rebreached.heldSince, null)
			assert.lengthOf((yield* alerts.listDeliveryEvents(orgId)).events, 2)

			// Quiet again 25 minutes later: the clock starts now, not at the first
			// hold, so this is nowhere near the 30-minute ceiling.
			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 25)
			const secondHold = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(secondHold.status, "open")
			assert.strictEqual(secondHold.heldSince, new Date(state.liveness.nowMs).toISOString())
			yield* tickAfter(state, alerts, 5)
			assert.strictEqual((yield* paymentsIncident(alerts, orgId)).status, "open")
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})

	it.effect("gates a multi-service rule's silent service the same way as an orphaned group", () => {
		const testDb = createTestDb(trackedDbs)
		// `serviceNames` rules evaluate each service on its own, so a silent
		// service is a `skipped` evaluation on an open incident rather than an
		// orphan. Before the gate that froze the incident forever.
		// checkout stays loud throughout; only payments thins out. The probe must
		// scope to the quiet service: summed with checkout the ratio is 189/344 and
		// checkout's traffic would vouch for payments.
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			liveness: {
				observed: 19,
				observedByService: { checkout: 170 },
				onset: 172,
				priorDay: 0,
				failProbe: false,
				nowMs: 0,
			},
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_hold_multi_service")
			const userId = asUserId("user_hold_multi_service")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id, {
				serviceNames: ["checkout", "payments"],
			})
			yield* alerts.runSchedulerTick()
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 2)

			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)
			const held = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(held.status, "open")
			assert.strictEqual(held.holdReason, "volume_collapsed")

			state.liveness.observedByService = { checkout: 170, payments: 170 }
			yield* tickAfter(state, alerts, 1)
			const resolved = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(resolved.status, "resolved")
			assert.strictEqual(resolved.holdReason, null)
			const events = yield* alerts.listDeliveryEvents(orgId)
			assert.deepStrictEqual(
				events.events.map((e) => e.eventType),
				["resolve", "trigger", "trigger"],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})

	it.effect("never resolves on the clock while the probe itself is failing", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			liveness: { observed: 172, onset: 172, priorDay: 0, failProbe: true, nowMs: 0 },
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_hold_probe_failed")
			const userId = asUserId("user_hold_probe_failed")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)
			assert.strictEqual((yield* paymentsIncident(alerts, orgId)).holdReason, "probe_failed")

			// Seven hours of our own warehouse failing says nothing about their
			// traffic: still held.
			yield* tickAfter(state, alerts, 7 * 60)
			assert.strictEqual((yield* paymentsIncident(alerts, orgId)).status, "open")

			// The first successful probe decides.
			state.liveness.failProbe = false
			yield* tickAfter(state, alerts, 1)
			assert.strictEqual((yield* paymentsIncident(alerts, orgId)).status, "resolved")
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})
})
