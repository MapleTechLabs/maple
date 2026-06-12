import { afterEach, describe, expect, it } from "@effect/vitest"
import { Cause, Clock, ConfigProvider, Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import {
	AlertDestinationInUseError,
	AlertForbiddenError,
	type AlertDestinationId,
	AlertRuleUpsertRequest,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import type { WarehouseQueryServiceShape } from "../lib/WarehouseQueryService"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import { AlertRuntime, type AlertRuntimeShape, AlertsService, type AlertsServiceShape } from "./AlertsService"
import { BucketCacheService, EdgeCacheService } from "@maple/query-engine/caching"
import { CacheBackendLive } from "../lib/CacheBackendLive"
import { Env } from "../lib/Env"
import { HazelOAuthService } from "./HazelOAuthService"
import { QueryEngineService } from "./QueryEngineService"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "../lib/test-pglite"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined

	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure !== undefined) return failure

	return Cause.squash(exit.cause)
}

/**
 * Runs an Effect-returning test body via `Effect.runPromise`. We deliberately
 * avoid `@effect/vitest`'s `it.effect`/`it.live`: under bun those wrappers never
 * settle real timers (`Effect.sleep`) or macrotask promises, which the embedded
 * DB driver and the delivery dispatcher's `fetch` + `Effect.timeout` depend on.
 * Plain `runPromise` drives the real event loop correctly.
 */
const itEffect = (name: string, body: () => Effect.Effect<unknown, unknown, never>) =>
	it(name, () => Effect.runPromise(body()))

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://maple-managed.tinybird.co",
			TINYBIRD_TOKEN: "managed-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
			MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
			QE_EVAL_BUCKET_CACHE_ENABLED: "false",
		}),
	)

const emptyWarehouseRows = [] as ReadonlyArray<Record<string, unknown>>

function makeWarehouseStub(state: {
	tracesAggregateRows?: ReadonlyArray<Record<string, unknown>>
	metricsAggregateRows?: ReadonlyArray<Record<string, unknown>>
	logsAggregateRows?: ReadonlyArray<Record<string, unknown>>
	logsAggregateByServiceRows?: ReadonlyArray<Record<string, unknown>>
	rawQueryRows?: ReadonlyArray<Record<string, unknown>>
}): WarehouseQueryServiceShape {
	const succeedRows = (rows: ReadonlyArray<Record<string, unknown>>) => Effect.succeed(rows as never)

	// All alert queries now go through sqlQuery (raw SQL via CH query engine).
	// Route the response based on what data is configured in the test state.
	const sqlQueryStub = () => {
		// Return whichever data is configured — tests evaluate one rule type at a time
		if (state.rawQueryRows?.length) return succeedRows(state.rawQueryRows)
		if (state.logsAggregateByServiceRows?.length) return succeedRows(state.logsAggregateByServiceRows)
		if (state.tracesAggregateRows?.length) return succeedRows(state.tracesAggregateRows)
		if (state.metricsAggregateRows?.length) return succeedRows(state.metricsAggregateRows)
		if (state.logsAggregateRows?.length) return succeedRows(state.logsAggregateRows)
		return succeedRows(emptyWarehouseRows)
	}

	return {
		query: (_tenant, payload) => Effect.fail(new Error(`Unexpected pipe ${payload.pipe}`)) as never,
		sqlQuery: sqlQueryStub,
		compiledQuery: (_tenant, compiled) =>
			sqlQueryStub().pipe(Effect.flatMap((rows) => compiled.decodeRows(rows).pipe(Effect.orDie))),
		compiledQueryFirst: (_tenant, compiled) =>
			sqlQueryStub().pipe(Effect.flatMap((rows) => compiled.decodeFirstRow(rows).pipe(Effect.orDie))),
		ingest: () => Effect.void,
		asExecutor: () => {
			throw new Error("asExecutor is not supported by this test stub")
		},
	}
}

const defaultTestRuntime: AlertRuntimeShape = {
	// Time is sourced from Effect's Clock (overridden per-test by a manual clock
	// for deterministic scheduler timestamps).
	now: Clock.currentTimeMillis,
	makeUuid: () => crypto.randomUUID(),
	fetch: globalThis.fetch,
	deliveryTimeoutMs: () => 15_000,
}

/**
 * A controllable clock that backs the `AlertRuntime.now` seam. Time for the
 * alerts domain itself (scheduler timestamps and the per-rule scheduler lock) is
 * fully deterministic: it starts from a fixed epoch and only moves when a test
 * calls `adjust`/`setTime`, mirroring `TestClock` semantics without ever reading
 * wall-clock time (`Date.now`). The runtime clock stays live so the embedded
 * DB driver and the dispatcher's real `fetch` + `Effect.timeout` keep working.
 */
interface ManualClock {
	readonly now: Effect.Effect<number>
	readonly setTime: (epochMs: number) => Effect.Effect<void>
	readonly adjust: (duration: Duration.Input) => Effect.Effect<void>
}

const DEFAULT_CLOCK_EPOCH_MS = 1_700_000_000_000

const makeManualClock = (startMs: number = DEFAULT_CLOCK_EPOCH_MS): ManualClock => {
	let currentMs = startMs
	return {
		now: Effect.sync(() => currentMs),
		setTime: (epochMs) =>
			Effect.sync(() => {
				currentMs = epochMs
			}),
		adjust: (duration) =>
			Effect.sync(() => {
				currentMs += Duration.toMillis(duration)
			}),
	}
}

const makeLayer = (
	testDb: TestDb,
	warehouseStub: WarehouseQueryServiceShape,
	runtimeOverrides?: Partial<AlertRuntimeShape>,
) => {
	const configLive = makeConfig()
	const envLive = Env.layer.pipe(Layer.provide(configLive))
	const databaseLive = testDb.layer
	const warehouseLive = Layer.succeed(WarehouseQueryService, warehouseStub)
	const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))
	const bucketCacheLive = BucketCacheService.layer.pipe(Layer.provide(edgeCacheLive))
	const queryEngineLive = QueryEngineService.layer.pipe(
		Layer.provide(warehouseLive),
		Layer.provide(edgeCacheLive),
		Layer.provide(bucketCacheLive),
		// Wire the test config so QE_EVAL_BUCKET_CACHE_ENABLED=false reaches
		// QueryEngineService. These alert-logic stubs return aggregate-shaped rows
		// (no per-bucket timestamps), which the bucket-cached evaluate path can't
		// bucket; keep alerts on the blob path. (Bucket path: QueryEngineEvaluateCache.test.ts.)
		Layer.provide(configLive),
	)
	const runtimeLive = Layer.succeed(AlertRuntime, { ...defaultTestRuntime, ...runtimeOverrides })
	const hazelOAuthLive = HazelOAuthService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, databaseLive)))

	return AlertsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(envLive, databaseLive, queryEngineLive, warehouseLive, runtimeLive, hazelOAuthLive),
		),
	) as Layer.Layer<AlertsService, never, never>
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const adminRoles = [asRoleName("root")]
const memberRoles = [asRoleName("org:member")]

const createWebhookDestination = (
	alerts: AlertsServiceShape,
	orgId: ReturnType<typeof asOrgId>,
	userId: ReturnType<typeof asUserId>,
) =>
	alerts.createDestination(orgId, userId, adminRoles, {
		type: "webhook",
		name: "Primary webhook",
		enabled: true,
		url: "https://example.com/maple-alerts",
		signingSecret: "webhook-secret",
	})

const createErrorRateRule = (
	alerts: AlertsServiceShape,
	orgId: ReturnType<typeof asOrgId>,
	userId: ReturnType<typeof asUserId>,
	destinationId: AlertDestinationId,
) =>
	alerts.createRule(
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
			destinationIds: [destinationId],
		}),
	)

const makeUuidSequence = (...values: string[]): Pick<AlertRuntimeShape, "makeUuid"> => {
	let index = 0
	return {
		makeUuid: () => values[index++] ?? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
	}
}

const okFetch: typeof fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

const insertDeliveryEventRow = async (
	db: TestDb,
	row: {
		id: string
		orgId: string
		incidentId: string | null
		ruleId: string
		destinationId: string
		deliveryKey: string
		eventType: string
		attemptNumber: number
		status: string
		scheduledAt: number
		payloadJson: string
		createdAt?: number
		updatedAt?: number
	},
) => {
	await executeSql(
		db,
		`
      insert into alert_delivery_events (
        id,
        org_id,
        incident_id,
        rule_id,
        destination_id,
        delivery_key,
        event_type,
        attempt_number,
        status,
        scheduled_at,
        claimed_at,
        claim_expires_at,
        claimed_by,
        attempted_at,
        provider_message,
        provider_reference,
        response_code,
        error_message,
        payload_json,
        created_at,
        updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null, null, null, null, null, null, null, null, $11::jsonb, $12, $13)
    `,
		[
			row.id,
			row.orgId,
			row.incidentId,
			row.ruleId,
			row.destinationId,
			row.deliveryKey,
			row.eventType,
			row.attemptNumber,
			row.status,
			new Date(row.scheduledAt),
			row.payloadJson,
			new Date(row.createdAt ?? row.scheduledAt),
			new Date(row.updatedAt ?? row.scheduledAt),
		],
	)
}

describe("AlertsService", () => {
	itEffect("opens an incident after consecutive breaches and delivers the webhook notification", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
				{
					count: 200,
					avgDuration: 40,
					p50Duration: 20,
					p95Duration: 120,
					p99Duration: 240,
					errorRate: 10,
					satisfiedCount: 180,
					toleratingCount: 10,
					apdexScore: 0.925,
				},
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

		const clock = makeManualClock()

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alerts")
			const userId = asUserId("user_alerts")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			const incidentsAfterFirstTick = yield* alerts.listIncidents(orgId)

			// Advance past the scheduler lock TTL so the rule can be claimed again.
			yield* clock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const incidentsAfterSecondTick = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			expect(incidentsAfterFirstTick.incidents).toHaveLength(0)
			expect(incidentsAfterSecondTick.incidents).toHaveLength(1)
			expect(incidentsAfterSecondTick.incidents[0]?.status).toBe("open")
			expect(events.events).toHaveLength(1)
			expect(events.events[0]?.status).toBe("success")
			expect(events.events[0]?.eventType).toBe("trigger")
			expect(requests).toHaveLength(1)
			expect(requests[0]?.url).toBe("https://example.com/maple-alerts")
			expect(requests[0]?.headers.get("x-maple-signature")).toBeTruthy()
			expect(requests[0]?.headers.get("x-maple-event-type")).toBe("trigger")
			expect(requests[0]?.headers.get("x-maple-delivery-key")).toBe(events.events[0]?.deliveryKey)
			expect(requests[0]?.headers.get("x-maple-delivery-key")).not.toBe(
				incidentsAfterSecondTick.incidents[0]?.dedupeKey,
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { now: clock.now, fetch: fetchImpl })))
	})

	itEffect("snapshots a custom notification template into the delivered payload", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
				{
					count: 200,
					avgDuration: 40,
					p50Duration: 20,
					p95Duration: 120,
					p99Duration: 240,
					errorRate: 10,
					satisfiedCount: 180,
					toleratingCount: 10,
					apdexScore: 0.925,
				},
			],
		}
		const bodies: string[] = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(typeof init?.body === "string" ? init.body : "")
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		const clock = makeManualClock()

		return Effect.gen(function* () {
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
			yield* clock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			// The custom template is re-read from the rule and surfaces through
			// get_alert_rule / listRules.
			const rules = yield* alerts.listRules(orgId)
			expect(rules.rules[0]?.notificationTemplate?.title).toBe(
				"{{ severity }} on {{ rule.name }}",
			)

			// The webhook body is the snapshotted delivery payload — it carries the
			// template so retries and downstream consumers render the same message.
			expect(bodies).toHaveLength(1)
			const payload = JSON.parse(bodies[0]!) as {
				template?: { title?: string; body?: string }
			}
			expect(payload.template?.title).toBe("{{ severity }} on {{ rule.name }}")
			expect(payload.template?.body).toBe("*Observed:* {{ observed.summary }}")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { now: clock.now, fetch: fetchImpl })))
	})

	itEffect("skips no-data error-rate rules instead of opening incidents", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: emptyWarehouseRows,
		}
		const clock = makeManualClock()

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_skipped")
			const userId = asUserId("user_skipped")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			yield* clock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			expect(incidents.incidents).toHaveLength(0)
			expect(events.events).toHaveLength(0)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { now: clock.now })))
	})

	itEffect("treats no data as a breach for throughput-below-threshold rules", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: emptyWarehouseRows,
		}
		const clock = makeManualClock()

		return Effect.gen(function* () {
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
			yield* clock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			expect(incidents.incidents).toHaveLength(1)
			expect(incidents.incidents[0]?.status).toBe("open")
			expect(incidents.incidents[0]?.signalType).toBe("throughput")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { now: clock.now, fetch: okFetch })))
	})

	itEffect("persists compiled query plans when rules are created", () => {
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

			expect(row).toBeTruthy()
			expect(row?.reducer).toBe("identity")
			expect(row?.sampleCountStrategy).toBe("trace_count")
			expect(row?.noDataBehavior).toBe("skip")
			expect(row?.querySpecJson).toMatchObject({
				kind: "timeseries",
				source: "traces",
				metric: "error_rate",
				groupBy: ["none"],
				filters: {
					serviceName: "checkout",
				},
			})
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))))
	})

	itEffect("resolves an open incident after consecutive healthy evaluations", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
				{
					count: 200,
					avgDuration: 40,
					p50Duration: 20,
					p95Duration: 120,
					p99Duration: 240,
					errorRate: 10,
					satisfiedCount: 180,
					toleratingCount: 10,
					apdexScore: 0.925,
				},
			] as ReadonlyArray<Record<string, unknown>>,
		}
		const clock = makeManualClock()

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_resolve")
			const userId = asUserId("user_resolve")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			yield* clock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			state.tracesAggregateRows = [
				{
					count: 200,
					avgDuration: 20,
					p50Duration: 10,
					p95Duration: 80,
					p99Duration: 160,
					errorRate: 0.5,
					satisfiedCount: 195,
					toleratingCount: 3,
					apdexScore: 0.9825,
				},
			]

			yield* clock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			yield* clock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			expect(incidents.incidents).toHaveLength(1)
			expect(incidents.incidents[0]?.status).toBe("resolved")
			expect(events.events.map((event: { eventType: string }) => event.eventType)).toEqual([
				"resolve",
				"trigger",
			])
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { now: clock.now, fetch: okFetch })))
	})

	itEffect("sends signed webhook test notifications", () => {
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

			expect(response.success).toBe(true)
			expect(requests).toHaveLength(1)
			expect(requests[0]?.headers.get("x-maple-event-type")).toBe("test")
			expect(requests[0]?.headers.get("x-maple-signature")).toBeTruthy()
			expect(requests[0]?.body).toContain('"eventType":"test"')
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	itEffect("keeps processing queued deliveries when a rule evaluation fails", () => {
		const fixedTime = 1_710_000_000_000
		const testDb = createTestDb(trackedDbs)
		const requests: Array<{ headers: Headers }> = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ headers: new Headers(init?.headers) })
			return new Response("ok", { status: 200 })
		}) as typeof fetch
		// Pin the clock to fixedTime so the pre-seeded delivery (scheduledAt: fixedTime - 1) is due.
		const clock = makeManualClock(fixedTime)

		return Effect.gen(function* () {
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

			expect(tick.evaluationFailureCount).toBe(1)
			expect(tick.processedCount).toBe(1)
			expect(tick.deliveryFailureCount).toBe(0)
			expect(requests).toHaveLength(1)
			expect(events.events[0]?.status).toBe("success")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					now: clock.now,
					fetch: fetchImpl,
				}),
			),
		)
	})

	itEffect("suppresses duplicate delivery sends across concurrent service instances", () => {
		const fixedTime = 1_710_000_100_000
		const testDb = createTestDb(trackedDbs)
		let requestCount = 0
		const fetchImpl = (async () => {
			requestCount += 1
			return new Response("ok", { status: 200 })
		}) as unknown as typeof fetch

		const stub = makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows })
		// One shared clock pinned to fixedTime backs every service instance below.
		const clock = makeManualClock(fixedTime)
		const overrides = { now: clock.now, fetch: fetchImpl }

		return Effect.gen(function* () {
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

			expect(requestCount).toBe(1)
			expect(tickA.processedCount + tickB.processedCount).toBe(1)
			expect(
				events.events.find((event) => event.deliveryKey === "shared-delivery-key")?.status,
			).toBe("success")
		})
	})

	itEffect("skips duplicate delivery events and still creates the incident", () => {
		const fixedTime = 1_710_000_200_000
		const testDb = createTestDb(trackedDbs)

		const state = {
			tracesAggregateRows: [
				{
					count: 200,
					avgDuration: 40,
					p50Duration: 20,
					p95Duration: 120,
					p99Duration: 240,
					errorRate: 10,
					satisfiedCount: 180,
					toleratingCount: 10,
					apdexScore: 0.925,
				},
			],
		}
		const clock = makeManualClock(fixedTime)
		const overrides = {
			now: clock.now,
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

				expect(tick.evaluationFailureCount).toBe(0)
				expect(incidents.incidents).toHaveLength(1)
				// Only the pre-existing event — the duplicate was silently skipped
				expect(events.events).toHaveLength(1)
				expect(events.events[0]?.deliveryKey).toContain(":trigger:")
			}).pipe(Effect.provide(layer))
	})

	itEffect("times out stuck deliveries and enqueues a retry attempt", () => {
		const fixedTime = 1_710_000_300_000
		const testDb = createTestDb(trackedDbs)
		const hangingFetch = (() => new Promise(() => {})) as unknown as typeof fetch
		const clock = makeManualClock(fixedTime)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_timeout")
			const userId = asUserId("user_timeout")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

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
					}),
				}),
			)

			// The dispatch wraps the hanging fetch in a 10ms timeout driven by the
			// live runtime clock, so the timeout fires on its own in real time.
			const tick = yield* alerts.runSchedulerTick()
			const events = yield* alerts.listDeliveryEvents(orgId)

			expect(tick.processedCount).toBe(1)
			expect(tick.deliveryFailureCount).toBe(1)
			const timeoutEvent = events.events.find(
				(event) => event.deliveryKey === "timeout-delivery-key" && event.attemptNumber === 1,
			)
			const retryEvent = events.events.find(
				(event) => event.deliveryKey === "timeout-delivery-key" && event.attemptNumber === 2,
			)
			expect(timeoutEvent?.status).toBe("failed")
			expect(timeoutEvent?.errorMessage).toContain("timed out")
			expect(retryEvent?.status).toBe("queued")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					now: clock.now,
					fetch: hangingFetch,
					deliveryTimeoutMs: () => 10,
				}),
			),
		)
	})

	itEffect("marks corrupted queued payloads as failed without blocking later deliveries", () => {
		const fixedTime = 1_710_000_400_000
		const testDb = createTestDb(trackedDbs)
		let requestCount = 0
		const fetchImpl = (async () => {
			requestCount += 1
			return new Response("ok", { status: 200 })
		}) as unknown as typeof fetch
		const clock = makeManualClock(fixedTime)

		return Effect.gen(function* () {
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
					// payload that fails the delivery-payload schema decode.
					payloadJson: JSON.stringify({ corrupted: true }),
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

			expect(tick.processedCount).toBe(2)
			expect(tick.deliveryFailureCount).toBe(1)
			expect(requestCount).toBe(1)
			expect(events.events.find((event) => event.deliveryKey === "bad-payload-key")?.status).toBe(
				"failed",
			)
			expect(events.events.find((event) => event.deliveryKey === "good-payload-key")?.status).toBe(
				"success",
			)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					now: clock.now,
					fetch: fetchImpl,
				}),
			),
		)
	})

	it("evaluates logs query alerts in testRule without failing validation", async () => {
		const testDb = createTestDb(trackedDbs)

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_logs_test")
				const userId = asUserId("user_logs_test")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)

				return yield* alerts.testRule(
					orgId,
					userId,
					adminRoles,
					new AlertRuleUpsertRequest({
						name: "Checkout error logs",
						severity: "critical",
						enabled: true,
						signalType: "builder_query",
						queryBuilderDraft: {
							id: "q",
							name: "A",
							dataSource: "logs",
							aggregation: "count",
							whereClause: 'service.name = "checkout" AND severity = "error"',
						},
						comparator: "gt",
						threshold: 10,
						windowMinutes: 5,
						minimumSampleCount: 1,
						consecutiveBreachesRequired: 2,
						consecutiveHealthyRequired: 2,
						renotifyIntervalMinutes: 30,
						destinationIds: [destination.id],
					}),
				)
			}).pipe(
				Effect.provide(
					makeLayer(
						testDb,
						makeWarehouseStub({
							logsAggregateRows: [{ count: 42 }],
						}),
					),
				),
			),
		)

		expect(result.status).toBe("breached")
		expect(result.value).toBe(42)
		expect(result.sampleCount).toBe(42)
	})

	it("compiles and evaluates a raw SQL query alert", async () => {
		const testDb = createTestDb(trackedDbs)

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_raw_sql_test")
				const userId = asUserId("user_raw_sql_test")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)

				return yield* alerts.testRule(
					orgId,
					userId,
					adminRoles,
					new AlertRuleUpsertRequest({
						name: "Raw SQL alert",
						severity: "critical",
						enabled: true,
						signalType: "raw_query",
						rawQuerySql:
							"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
						rawQueryReducer: "max",
						comparator: "gt",
						threshold: 100,
						windowMinutes: 5,
						minimumSampleCount: 0,
						consecutiveBreachesRequired: 2,
						consecutiveHealthyRequired: 2,
						renotifyIntervalMinutes: 30,
						destinationIds: [destination.id],
					}),
				)
			}).pipe(
				Effect.provide(
					makeLayer(
						testDb,
						makeWarehouseStub({
							rawQueryRows: [
								{ value: 120, samples: 8 },
								{ value: 240, samples: 12 },
							],
						}),
					),
				),
			),
		)

		expect(result.status).toBe("breached")
		expect(result.value).toBe(240)
		expect(result.sampleCount).toBe(20)
	})

	it("rejects metrics alerts with multiple attr groupBy dimensions", async () => {
		const testDb = createTestDb(trackedDbs)

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_metrics_group_validation")
				const userId = asUserId("user_metrics_group_validation")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)

				return yield* alerts.createRule(
					orgId,
					userId,
					adminRoles,
					new AlertRuleUpsertRequest({
						name: "Grouped metrics alert",
						severity: "warning",
						enabled: true,
						groupBy: ["attr.http.method", "attr.http.route"],
						signalType: "metric",
						comparator: "gt",
						threshold: 100,
						windowMinutes: 5,
						minimumSampleCount: 1,
						consecutiveBreachesRequired: 1,
						consecutiveHealthyRequired: 1,
						renotifyIntervalMinutes: 30,
						metricName: "http.server.request.duration",
						metricType: "histogram",
						metricAggregation: "avg",
						destinationIds: [destination.id],
					}),
				)
			}).pipe(
				Effect.provide(makeLayer(testDb, makeWarehouseStub({ metricsAggregateRows: emptyWarehouseRows }))),
			),
		)

		const failure = getError(exit)

		expect(Exit.isFailure(exit)).toBe(true)
		expect(failure).toMatchObject({
			message: "Metrics alerts support at most one attr.* groupBy dimension",
		})
	})

	itEffect("opens per-service incidents for grouped logs query alerts", () => {
		const testDb = createTestDb(trackedDbs)
		const clock = makeManualClock()

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_logs_grouped")
			const userId = asUserId("user_logs_grouped")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "All services error logs",
					severity: "critical",
					enabled: true,
					signalType: "builder_query",
					queryBuilderDraft: {
						id: "q",
						name: "A",
						dataSource: "logs",
						aggregation: "count",
						whereClause: 'severity = "error"',
						groupBy: ["service.name"],
						addOns: {
							groupBy: true,
							having: false,
							orderBy: false,
							limit: false,
							legend: false,
						},
					},
					groupBy: ["service.name"],
					comparator: "gt",
					threshold: 10,
					windowMinutes: 5,
					minimumSampleCount: 1,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
				}),
			)

			yield* alerts.runSchedulerTick()
			yield* clock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			expect(incidents.incidents).toHaveLength(1)
			expect(incidents.incidents[0]?.groupKey).toBe("svc-breach")
			expect(incidents.incidents[0]?.status).toBe("open")
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({
						logsAggregateByServiceRows: [
							{ bucket: "2026-01-01 00:00:00", groupName: "svc-breach", count: 14 },
							{ bucket: "2026-01-01 00:00:00", groupName: "svc-healthy", count: 3 },
						],
					}),
					{ now: clock.now, fetch: okFetch },
				),
			),
		)
	})

	it("blocks destination deletion when rules still reference it", async () => {
		const testDb = createTestDb(trackedDbs)

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_delete_guard")
				const userId = asUserId("user_delete_guard")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)

				yield* createErrorRateRule(alerts, orgId, userId, destination.id)

				return yield* alerts.deleteDestination(orgId, adminRoles, destination.id)
			}).pipe(
				Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
			),
		)

		const failure = getError(exit)
		expect(Exit.isFailure(exit)).toBe(true)
		expect(failure).toBeInstanceOf(AlertDestinationInUseError)
		expect(failure).toMatchObject({
			destinationId: expect.any(String),
			ruleNames: ["Checkout error rate"],
		})
	})

	it("rejects destination creation for non-admin members", async () => {
		const testDb = createTestDb(trackedDbs)

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.createDestination(
					asOrgId("org_forbidden"),
					asUserId("user_forbidden"),
					memberRoles,
					{
						type: "webhook",
						name: "Member webhook",
						enabled: true,
						url: "https://example.com/member",
					},
				)
			}).pipe(
				Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
			),
		)

		const failure = getError(exit)

		expect(Exit.isFailure(exit)).toBe(true)
		expect(failure).toBeInstanceOf(AlertForbiddenError)
	})

	itEffect("dedupes destinationIds on create and update, preserving selection order", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_dedupe_destinations")
			const userId = asUserId("user_dedupe_destinations")

			const primary = yield* createWebhookDestination(alerts, orgId, userId)
			const secondary = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "webhook",
				name: "Secondary webhook",
				enabled: true,
				url: "https://example.com/secondary",
				signingSecret: "webhook-secret-2",
			})

			const baseRule = {
				name: "Duplicate destination rule",
				severity: "warning",
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
			} as const

			// Create with the same id repeated, interleaved with a distinct id — the
			// duplicates collapse but the first-seen order survives.
			const created = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					...baseRule,
					destinationIds: [primary.id, secondary.id, primary.id],
				}),
			)
			expect(created.destinationIds).toEqual([primary.id, secondary.id])

			// Updating with duplicates is deduped on the write path too.
			const updated = yield* alerts.updateRule(
				orgId,
				userId,
				adminRoles,
				created.id,
				new AlertRuleUpsertRequest({
					...baseRule,
					destinationIds: [secondary.id, secondary.id],
				}),
			)
			expect(updated.destinationIds).toEqual([secondary.id])

			// The persisted row read back is deduped, not just the returned document.
			const rules = yield* alerts.listRules(orgId)
			expect(rules.rules).toHaveLength(1)
			expect(rules.rules[0]?.destinationIds).toEqual([secondary.id])
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))))
	})

	itEffect("opens per-service incidents for multi-service rules", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
				{
					count: 200,
					avgDuration: 40,
					p50Duration: 20,
					p95Duration: 120,
					p99Duration: 240,
					errorRate: 10,
					satisfiedCount: 180,
					toleratingCount: 10,
					apdexScore: 0.925,
				},
			],
		}
		const clock = makeManualClock()

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_multi_svc")
			const userId = asUserId("user_multi_svc")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Multi-service error rate",
					severity: "critical",
					enabled: true,
					serviceNames: ["svc-a", "svc-b"],
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

			yield* alerts.runSchedulerTick()
			yield* clock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			expect(incidents.incidents).toHaveLength(2)
			const groupKeys = incidents.incidents.map((i: { groupKey: string | null }) => i.groupKey).sort()
			expect(groupKeys).toEqual(["svc-a", "svc-b"])
			expect(incidents.incidents.every((i: { status: string }) => i.status === "open")).toBe(true)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { now: clock.now, fetch: okFetch })))
	})

	itEffect("opens per-service incidents for groupBy=service rules", () => {
		const testDb = createTestDb(trackedDbs)

		const breachingRow = {
			bucket: "2026-01-01 00:00:00",
			groupName: "svc-breach",
			count: 200,
			avgDuration: 40,
			p50Duration: 20,
			p95Duration: 120,
			p99Duration: 240,
			errorRate: 10,
			satisfiedCount: 180,
			toleratingCount: 10,
			apdexScore: 0.925,
			estimatedSpanCount: 200,
		}
		const healthyRow = {
			bucket: "2026-01-01 00:00:00",
			groupName: "svc-healthy",
			count: 200,
			avgDuration: 20,
			p50Duration: 10,
			p95Duration: 80,
			p99Duration: 160,
			errorRate: 0.5,
			satisfiedCount: 195,
			toleratingCount: 3,
			apdexScore: 0.9825,
			estimatedSpanCount: 200,
		}

		const alertRows = [breachingRow, healthyRow] as ReadonlyArray<Record<string, unknown>>
		const stub: WarehouseQueryServiceShape = {
			...makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }),
			sqlQuery: () => Effect.succeed(alertRows) as never,
			compiledQuery: (_tenant, compiled) =>
				compiled.decodeRows(alertRows).pipe(Effect.orDie) as never,
			compiledQueryFirst: (_tenant, compiled) =>
				compiled.decodeFirstRow(alertRows).pipe(Effect.orDie) as never,
		}
		const clock = makeManualClock()

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_grouped")
			const userId = asUserId("user_grouped")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "All services error rate",
					severity: "critical",
					enabled: true,
					groupBy: ["service.name"],
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

			yield* alerts.runSchedulerTick()
			yield* clock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			expect(incidents.incidents).toHaveLength(1)
			expect(incidents.incidents[0]?.groupKey).toBe("svc-breach")
			expect(incidents.incidents[0]?.status).toBe("open")
		}).pipe(Effect.provide(makeLayer(testDb, stub, { now: clock.now, fetch: okFetch })))
	})
})
