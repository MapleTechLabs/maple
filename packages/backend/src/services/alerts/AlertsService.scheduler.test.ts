// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import {
	type AlertEvaluationIntervalMinutes,
	AlertValidationError,
	WarehouseQuotaExceededError,
} from "@maple/domain/http"
import type { WarehouseQuerySettings } from "@maple/query-engine/profiles"
import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	Fiber,
	Array as Arr,
	Cause,
	Clock,
	Duration,
	Effect,
	Exit,
	HashMap,
	HashSet,
	Layer,
	Option,
	Order,
	Ref,
	Schema,
	Tracer,
} from "effect"
import { TestClock } from "effect/testing"
import { AlertRuleUpsertRequest, OrgId } from "@maple/domain/http"
import type { WarehouseQueryServiceApi } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { AlertsService, type AlertsServiceApi } from "./AlertsService"
import {
	baselineWarehouseCapabilities,
	formatWarehouseDateTime,
	isAlertRuleDue,
	snapAlertWindowEndMs,
} from "@maple/query-engine"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { Database, DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { makeRecordingTracer, spansNamed } from "@maple/backend/testing/recording-tracer"
import { fakeChatSessions } from "@maple/backend/platform/chat-sessions-fake"
import { IncidentClassifier } from "@maple/backend/services/errors/IncidentClassifier"
import {
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
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

describe("AlertsService evaluation cadence", () => {
	const createCadenceRule = (alerts: AlertsServiceApi, orgId: OrgId, windowMinutes: number) =>
		createWebhookDestination(alerts, orgId, asUserId("user_cadence")).pipe(
			Effect.flatMap((destination) =>
				alerts.createRule(
					orgId,
					asUserId("user_cadence"),
					adminRoles,
					new AlertRuleUpsertRequest({
						name: `Cadence ${windowMinutes}m`,
						severity: "warning",
						enabled: true,
						signalType: "error_rate",
						comparator: "gt",
						threshold: 5,
						windowMinutes,
						destinationIds: [destination.id],
					}),
				),
			),
		)

	// Runs `count` ticks a minute apart and returns each tick's evaluated count.
	const tickEveryMinute = (alerts: AlertsServiceApi, count: number) =>
		Effect.forEach(Arr.range(1, count), () =>
			alerts.runSchedulerTick().pipe(
				Effect.map((tick) => tick.evaluatedCount),
				Effect.tap(() => TestClock.adjust(Duration.minutes(1))),
			),
		)

	it.effect("checks a 15-minute rule every third minute and a 5-minute rule every minute", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createCadenceRule(alerts, asOrgId("org_cadence_short_a"), 5)
			yield* createCadenceRule(alerts, asOrgId("org_cadence_long"), 15)
			yield* createCadenceRule(alerts, asOrgId("org_cadence_short_b"), 5)

			const counts = yield* tickEveryMinute(alerts, 10)

			// Both 5-minute rules run every tick; the long rule adds one on its own minutes.
			const longTicks = Arr.filter(Arr.range(0, counts.length - 1), (index) => counts[index] === 3)
			assert.isTrue(counts.every((count) => count === 2 || count === 3))
			// The first tick runs it (never claimed), then it settles onto every third minute.
			assert.strictEqual(longTicks[0], 0)
			const settled = longTicks.slice(1)
			assert.isAtLeast(settled.length, 3)
			Arr.forEach(settled.slice(1), (tick, i) => assert.strictEqual(tick - settled[i]!, 3))
			assert.isAtMost(settled[0]!, 3)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
	})

	it.effect("checks an edited rule on the next tick instead of waiting for its slot", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_cadence_edit")
			const rule = yield* createCadenceRule(alerts, orgId, 30)
			const claimedAt = yield* Clock.currentTimeMillis
			yield* alerts.runSchedulerTick()

			// One of the next two minutes is off the rule's every-fifth-minute phase.
			const idle = [1, 2].find(
				(n) =>
					!isAlertRuleDue({
						ruleId: rule.id,
						intervalMinutes: 5,
						updatedAt: claimedAt,
						lastClaimedAt: claimedAt,
						windowEndMs: snapAlertWindowEndMs(claimedAt + n * 60_000),
					}),
			)!
			yield* TestClock.adjust(Duration.minutes(idle))
			// Back on an idle minute: an edit makes the rule due there.
			yield* alerts.updateRule(
				orgId,
				asUserId("user_cadence"),
				adminRoles,
				rule.id,
				new AlertRuleUpsertRequest({
					name: "Edited",
					severity: "warning",
					enabled: true,
					signalType: rule.signalType,
					comparator: rule.comparator,
					threshold: 10,
					windowMinutes: rule.windowMinutes,
					destinationIds: [...rule.destinationIds],
				}),
			)
			const afterEdit = yield* alerts.runSchedulerTick()
			assert.strictEqual(afterEdit.evaluatedCount, 1)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
	})
})

describe("AlertsService check intervals", () => {
	const RAW_SQL = "SELECT count() AS value FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)"

	// Records the settings each raw SQL query ran with.
	const recordingWarehouse = (settings: Array<WarehouseQuerySettings | undefined>) => {
		const stub = makeWarehouseStub({ rawQueryRows: [{ value: 1, samples: 1 }] })
		return {
			...stub,
			rawSqlQuery: (...args: Parameters<WarehouseQueryServiceApi["rawSqlQuery"]>) => {
				settings.push(args[2]?.settings)
				return stub.rawSqlQuery(...args)
			},
		} satisfies WarehouseQueryServiceApi
	}

	const createIntervalRule = (
		alerts: AlertsServiceApi,
		orgId: OrgId,
		rule: {
			readonly signalType: "raw_query" | "error_rate"
			readonly windowMinutes: number
			readonly evaluationIntervalMinutes: AlertEvaluationIntervalMinutes | null
		},
	) =>
		createWebhookDestination(alerts, orgId, asUserId("user_interval")).pipe(
			Effect.flatMap((destination) =>
				alerts.createRule(
					orgId,
					asUserId("user_interval"),
					adminRoles,
					new AlertRuleUpsertRequest({
						name: `Interval ${rule.signalType} ${rule.evaluationIntervalMinutes}`,
						severity: "warning",
						enabled: true,
						signalType: rule.signalType,
						...(rule.signalType === "raw_query" ? { rawQuerySql: RAW_SQL } : undefined),
						comparator: "gt",
						threshold: 5,
						windowMinutes: rule.windowMinutes,
						evaluationIntervalMinutes: rule.evaluationIntervalMinutes,
						destinationIds: [destination.id],
					}),
				),
			),
		)

	it.effect("runs a raw SQL rule checked every 10 minutes in the long-query lane with a 25s limit", () => {
		const testDb = createTestDb(trackedDbs)
		const settings: Array<WarehouseQuerySettings | undefined> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createIntervalRule(alerts, asOrgId("org_interval_long"), {
				signalType: "raw_query",
				windowMinutes: 10,
				evaluationIntervalMinutes: 10,
			})

			assert.strictEqual((yield* alerts.runSchedulerTick("standard")).evaluatedCount, 0)
			assert.strictEqual((yield* alerts.runSchedulerTick("long_query")).evaluatedCount, 1)
			assert.deepStrictEqual(settings, [{ maxExecutionTime: 25, maxMemoryUsage: 512_000_000 }])
		}).pipe(Effect.provide(makeLayer(testDb, recordingWarehouse(settings), { fetch: okFetch })))
	})

	it.effect("keeps a raw SQL rule checked every minute in the standard lane with a 5s limit", () => {
		const testDb = createTestDb(trackedDbs)
		const settings: Array<WarehouseQuerySettings | undefined> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createIntervalRule(alerts, asOrgId("org_interval_short"), {
				signalType: "raw_query",
				windowMinutes: 5,
				evaluationIntervalMinutes: null,
			})

			assert.strictEqual((yield* alerts.runSchedulerTick("long_query")).evaluatedCount, 0)
			assert.strictEqual((yield* alerts.runSchedulerTick("standard")).evaluatedCount, 1)
			assert.deepStrictEqual(settings, [{ maxExecutionTime: 5, maxMemoryUsage: 256_000_000 }])
		}).pipe(Effect.provide(makeLayer(testDb, recordingWarehouse(settings), { fetch: okFetch })))
	})

	it.effect("checks a rule on the interval its author picked", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			// A 15-minute window alone would be checked every third minute.
			yield* createIntervalRule(alerts, asOrgId("org_interval_builder"), {
				signalType: "error_rate",
				windowMinutes: 15,
				evaluationIntervalMinutes: 10,
			})

			const counts = yield* Effect.forEach(Arr.range(1, 25), () =>
				alerts.runSchedulerTick().pipe(
					Effect.map((tick) => tick.evaluatedCount),
					Effect.tap(() => TestClock.adjust(Duration.minutes(1))),
				),
			)
			const ran = Arr.filter(Arr.range(0, counts.length - 1), (index) => counts[index] === 1)
			// Right away (never claimed), then on its phase minute every ten.
			assert.strictEqual(ran[0], 0)
			const settled = ran.slice(1)
			assert.isAtMost(settled[0]!, 10)
			assert.isAtLeast(settled.length, 2)
			Arr.forEach(settled.slice(1), (tick, i) => assert.strictEqual(tick - settled[i]!, 10))
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
	})

	it.effect("defers a slow rule with no room left in the long-query lane to the very next tick", () => {
		const testDb = createTestDb(trackedDbs)
		// Each query takes 26 s two at a time, so the second pair would start with under 35 s of the 60 s budget left.
		const stub = makeWarehouseStub({ rawQueryRows: [{ value: 1, samples: 1 }] })
		const slowWarehouse = {
			...stub,
			rawSqlQuery: (...args: Parameters<WarehouseQueryServiceApi["rawSqlQuery"]>) =>
				Effect.andThen(Effect.sleep(Duration.seconds(26)), stub.rawSqlQuery(...args)),
		} satisfies WarehouseQueryServiceApi
		// A tick under the test clock, which moves a second at a time while the tick sleeps.
		const tickWithClock = (alerts: AlertsServiceApi) =>
			Effect.gen(function* () {
				const tick = yield* Effect.forkChild(alerts.runSchedulerTick("long_query"))
				yield* Effect.forEach(Arr.range(1, 90), () => TestClock.adjust(Duration.seconds(1)), {
					discard: true,
				})
				return yield* Fiber.join(tick)
			})
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* Effect.forEach(["a", "b", "c", "d"], (org) =>
				createIntervalRule(alerts, asOrgId(`org_interval_room_${org}`), {
					signalType: "raw_query",
					windowMinutes: 10,
					evaluationIntervalMinutes: 10,
				}),
			)

			const first = yield* tickWithClock(alerts)
			assert.deepStrictEqual(
				{
					evaluated: first.evaluatedCount,
					failed: first.evaluationFailureCount,
					deferred: first.deferredCount,
				},
				{ evaluated: 2, failed: 0, deferred: 2 },
			)
			// Their claims were released, so they run on the next tick rather than on their next 10-minute slot.
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS + 2 * 60_000)
			assert.strictEqual((yield* tickWithClock(alerts)).evaluatedCount, 2)
		}).pipe(Effect.provide(makeLayer(testDb, slowWarehouse, { fetch: okFetch })))
	})

	it.effect("rejects a check interval longer than the window", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const exit = yield* createIntervalRule(alerts, asOrgId("org_interval_gap"), {
				signalType: "error_rate",
				windowMinutes: 5,
				evaluationIntervalMinutes: 15,
			}).pipe(Effect.exit)
			const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null
			assert.instanceOf(error, AlertValidationError)
			assert.include(
				error instanceof AlertValidationError ? error.details.join("\n") : "",
				"must be at least evaluationIntervalMinutes",
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
	})

	// A raw SQL warehouse whose queries run 6s and time out while `failing` holds.
	const timingOutWarehouse = (state: {
		failing: boolean
		readonly limits: Array<number | undefined>
		readonly checkDurations: Array<unknown>
	}) => {
		const stub = makeWarehouseStub({ rawQueryRows: [{ value: 1, samples: 1 }] })
		return {
			...stub,
			rawSqlQuery: (...args: Parameters<WarehouseQueryServiceApi["rawSqlQuery"]>) =>
				Effect.gen(function* () {
					state.limits.push(args[2]?.settings?.maxExecutionTime)
					yield* TestClock.adjust(Duration.seconds(6))
					if (!state.failing) return yield* stub.rawSqlQuery(...args)
					return yield* new WarehouseQuotaExceededError({
						message: "Timeout exceeded: elapsed 6000 ms",
						pipeName: "rawSqlQuery",
						setting: "max_execution_time",
					})
				}),
			ingest: (_tenant, datasource, rows) =>
				Effect.sync(() => {
					if (datasource === "alert_checks") {
						state.checkDurations.push(...rows.map((row) => row.EvaluationDurationMs))
					}
				}),
		} satisfies WarehouseQueryServiceApi
	}

	// Both lanes, once a minute.
	const tickBothLanes = (alerts: AlertsServiceApi, minutes: number) =>
		Effect.forEach(
			Arr.range(1, minutes),
			() =>
				alerts
					.runSchedulerTick("standard")
					.pipe(
						Effect.andThen(alerts.runSchedulerTick("long_query")),
						Effect.andThen(TestClock.adjust(Duration.minutes(1))),
					),
			{ discard: true },
		)

	it.effect("slows a rule whose query keeps timing out, a step at a time, up to its window", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			limits: [] as Array<number | undefined>,
			checkDurations: [] as Array<unknown>,
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_slowdown")
			// Checked every 2 minutes by its window, under the 5s limit.
			yield* createIntervalRule(alerts, orgId, {
				signalType: "raw_query",
				windowMinutes: 10,
				evaluationIntervalMinutes: null,
			})

			yield* tickBothLanes(alerts, 60)

			// Three timeouts at each limit, then 5-minute checks at 15s, then 10-minute checks at 25s.
			assert.deepStrictEqual(state.limits.slice(0, 9), [5, 5, 5, 15, 15, 15, 25, 25, 25])
			// The window caps it: 15 minutes would leave data unread between checks.
			assert.isTrue(state.limits.slice(6).every((limit) => limit === 25))
			assert.isAtMost(state.limits.length, 3 + 3 + 6)
			const [rule] = (yield* alerts.listRules(orgId)).rules
			assert.strictEqual(rule?.slowedIntervalMinutes, 10)
			assert.isNotNull(rule?.slowedAt)
			assert.strictEqual(rule?.lastEvaluationErrorKind, "query_too_slow")
			// A failed check records how long its query ran, not 0.
			assert.isNotEmpty(state.checkDurations)
			assert.isTrue(state.checkDurations.every((ms) => ms === 6000))
		}).pipe(Effect.provide(makeLayer(testDb, timingOutWarehouse(state), { fetch: okFetch })))
	})

	it.effect("does not slow a rule whose timeouts a clean check interrupts", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			limits: [] as Array<number | undefined>,
			checkDurations: [] as Array<unknown>,
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_slowdown_reset")
			yield* createIntervalRule(alerts, orgId, {
				signalType: "raw_query",
				windowMinutes: 5,
				evaluationIntervalMinutes: null,
			})

			yield* tickBothLanes(alerts, 2)
			state.failing = false
			yield* tickBothLanes(alerts, 1)
			state.failing = true
			yield* tickBothLanes(alerts, 2)

			assert.deepStrictEqual(state.limits, [5, 5, 5, 5, 5])
			const [rule] = (yield* alerts.listRules(orgId)).rules
			assert.isNull(rule?.slowedIntervalMinutes)
		}).pipe(Effect.provide(makeLayer(testDb, timingOutWarehouse(state), { fetch: okFetch })))
	})

	it.effect("gives a slowed rule its own interval back when it is edited", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			limits: [] as Array<number | undefined>,
			checkDurations: [] as Array<unknown>,
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_slowdown_edit")
			const created = yield* createIntervalRule(alerts, orgId, {
				signalType: "raw_query",
				windowMinutes: 5,
				evaluationIntervalMinutes: null,
			})
			yield* tickBothLanes(alerts, 3)
			assert.strictEqual((yield* alerts.listRules(orgId)).rules[0]?.slowedIntervalMinutes, 5)

			yield* alerts.updateRule(
				orgId,
				asUserId("user_interval"),
				adminRoles,
				created.id,
				new AlertRuleUpsertRequest({
					name: "Faster query",
					severity: "warning",
					signalType: "raw_query",
					rawQuerySql: RAW_SQL,
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					destinationIds: [...created.destinationIds],
				}),
			)
			state.failing = false
			state.limits.length = 0
			yield* tickBothLanes(alerts, 3)

			assert.deepStrictEqual(state.limits, [5, 5, 5])
			assert.isNull((yield* alerts.listRules(orgId)).rules[0]?.slowedIntervalMinutes)
		}).pipe(Effect.provide(makeLayer(testDb, timingOutWarehouse(state), { fetch: okFetch })))
	})
})

describe("AlertsService scheduler pool", () => {
	const RULE_COUNT = 50
	const SLOW_EVAL_MS = 3_000
	const FAST_EVAL_MS = 20

	type EvalDelay = Duration.Duration | "stuck"

	// A warehouse whose latency is chosen per org, one rule per org, so each rule's
	// evaluation time is set by the test. Records every org it was queried for.
	const makeSlowWarehouse = (delayFor: (orgId: string) => Effect.Effect<EvalDelay>) => {
		const queried = Ref.makeUnsafe(HashSet.empty<string>())
		const base = makeWarehouseStub({})
		const delayed = <A, E, R>(orgId: string, effect: Effect.Effect<A, E, R>) =>
			Ref.update(queried, HashSet.add(orgId)).pipe(
				Effect.andThen(delayFor(orgId)),
				Effect.flatMap((delay) => (delay === "stuck" ? Effect.never : Effect.sleep(delay))),
				Effect.andThen(effect),
			)
		const stub: WarehouseQueryServiceApi = {
			...base,
			sqlQuery: (tenant, ...rest) => delayed(tenant.orgId, base.sqlQuery(tenant, ...rest)),
			rawSqlQuery: (tenant, ...rest) => delayed(tenant.orgId, base.rawSqlQuery(tenant, ...rest)),
			compiledQuery: (tenant, ...rest) => delayed(tenant.orgId, base.compiledQuery(tenant, ...rest)),
			compiledQueryWithCapabilities: (tenant, ...rest) =>
				delayed(tenant.orgId, base.compiledQueryWithCapabilities(tenant, ...rest)),
			compiledQueryFirst: (tenant, ...rest) =>
				delayed(tenant.orgId, base.compiledQueryFirst(tenant, ...rest)),
		}
		return { stub, queried: Ref.get(queried) }
	}

	const orgAt = (index: number) => asOrgId(`org_pool_${String(index).padStart(2, "0")}`)

	// Created in index order with distinct updatedAt, which is the scheduler's order
	// for rules it has never claimed.
	const createPoolRules = (alerts: AlertsServiceApi) =>
		Effect.forEach(
			Arr.range(0, RULE_COUNT - 1),
			(index) =>
				createWebhookDestination(alerts, orgAt(index), asUserId("user_pool")).pipe(
					Effect.flatMap((destination) =>
						alerts.createRule(
							orgAt(index),
							asUserId("user_pool"),
							adminRoles,
							new AlertRuleUpsertRequest({
								name: "Pool rule",
								severity: "warning",
								enabled: true,
								signalType: "error_rate",
								comparator: "gt",
								threshold: 5,
								windowMinutes: 5,
								destinationIds: [destination.id],
							}),
						),
					),
					Effect.andThen(Effect.sleep("2 millis")),
				),
			{ discard: true },
		)

	const timedTick = (alerts: AlertsServiceApi) =>
		Effect.gen(function* () {
			const startedAt = yield* Clock.currentTimeMillis
			yield* alerts.runSchedulerTick()
			return (yield* Clock.currentTimeMillis) - startedAt
		})

	it.live("a slow rule holds one lane, not the whole claim chunk", () => {
		const testDb = createTestDb(trackedDbs)
		// 25 apart, so the two slow rules land in different claim chunks: a chunk
		// barrier would run them back to back.
		const { stub } = makeSlowWarehouse((orgId) =>
			Effect.succeed(
				orgId === orgAt(0) || orgId === orgAt(25)
					? Duration.millis(SLOW_EVAL_MS)
					: Duration.millis(FAST_EVAL_MS),
			),
		)
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			yield* createPoolRules(alerts)

			const wallMs = yield* timedTick(alerts)

			assert.isBelow(wallMs, SLOW_EVAL_MS * 1.5)
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
	})

	// Records when each org's first warehouse query started, i.e. when its rule began evaluating.
	const makeStartRecorder = () => {
		const firstQueryAt = Ref.makeUnsafe(HashMap.empty<string, number>())
		const { stub } = makeSlowWarehouse((orgId) =>
			Clock.currentTimeMillis.pipe(
				Effect.tap((ms) =>
					Ref.update(firstQueryAt, (starts) =>
						HashMap.has(starts, orgId) ? starts : HashMap.set(starts, orgId, ms),
					),
				),
				Effect.as(Duration.millis(FAST_EVAL_MS)),
			),
		)
		const startOffsets = (tickStartedAt: number) =>
			Ref.get(firstQueryAt).pipe(
				Effect.map((starts) =>
					Arr.map(Arr.range(0, RULE_COUNT - 1), (index) =>
						Option.match(HashMap.get(starts, orgAt(index)), {
							onNone: () => Number.NaN,
							onSome: (ms) => ms - tickStartedAt,
						}),
					),
				),
			)
		return { stub, startOffsets }
	}

	it.live("spaces rule starts evenly across the spread", () => {
		const testDb = createTestDb(trackedDbs)
		const spreadMs = 1_000
		const { stub, startOffsets } = makeStartRecorder()
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			yield* createPoolRules(alerts)

			const startedAt = yield* Clock.currentTimeMillis
			const tick = yield* alerts.runSchedulerTick()
			const offsets = yield* startOffsets(startedAt)

			assert.strictEqual(tick.evaluatedCount, RULE_COUNT)
			assert.strictEqual(tick.deferredCount, 0)
			// Rule i waits for its slot at i * spreadMs / RULE_COUNT. The upper bound is from the
			// first start, so the tick's setup before the spread is not counted against the slack.
			const slotMs = spreadMs / RULE_COUNT
			Arr.forEach(offsets, (offset, index) => {
				assert.isAtLeast(offset, index * slotMs)
				assert.isBelow(offset - offsets[0]!, index * slotMs + 500)
			})
		}).pipe(
			Effect.provide(makeLayer(testDb, stub, { fetch: okFetch, schedulerSpreadMs: () => spreadMs })),
		)
	})

	it.live("shortens the spread to fit the tick deadline instead of deferring rules", () => {
		const testDb = createTestDb(trackedDbs)
		// 10 s of the 11 s budget stays clear at the end, so 1 s is left to spread over.
		const roomMs = 1_000
		const { stub, startOffsets } = makeStartRecorder()
		const { spans, tracer } = makeRecordingTracer()
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			yield* createPoolRules(alerts)

			const startedAt = yield* Clock.currentTimeMillis
			const tick = yield* alerts.runSchedulerTick().pipe(Effect.withTracer(tracer))
			const offsets = yield* startOffsets(startedAt)

			assert.strictEqual(tick.evaluatedCount, RULE_COUNT)
			assert.strictEqual(tick.deferredCount, 0)
			assert.isBelow(Math.max(...offsets) - Math.min(...offsets), roomMs + 500)
			// The tick span reports the spread it actually used, not the configured 60 s.
			const [reported] = spansNamed(spans, "AlertsService.evaluateScheduledRules").map((span) =>
				span.attributes.get("maple.alerting.spread_ms"),
			)
			assert.isAbove(Number(reported), 0)
			assert.isAtMost(Number(reported), roomMs)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, stub, {
					fetch: okFetch,
					schedulerTickBudgetMs: () => 10_000 + roomMs,
					schedulerSpreadMs: () => 60_000,
				}),
			),
		)
	})

	it.live("claims each chunk only when its first rule's slot comes up", () => {
		const testDb = createTestDb(trackedDbs)
		const spreadMs = 2_000
		const { stub, startOffsets } = makeStartRecorder()
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			yield* createPoolRules(alerts)

			const startedAt = yield* Clock.currentTimeMillis
			yield* alerts.runSchedulerTick()
			const offsets = yield* startOffsets(startedAt)
			const claims = yield* Effect.promise(() =>
				testDb.pglite.query<{ orgId: string; claimedAt: Date }>(
					`select org_id as "orgId", last_scheduled_at as "claimedAt" from alert_rule_claims`,
				),
			)
			const claimOffset = new Map(
				claims.rows.map((row) => [row.orgId, row.claimedAt.getTime() - startedAt]),
			)

			// A claim is never older than one chunk of slots when its rule starts, so the
			// second chunk is claimed about halfway through the spread, not up front.
			const chunkSpanMs = (spreadMs / RULE_COUNT) * 25
			Arr.forEach(offsets, (offset, index) => {
				const claimedAt = claimOffset.get(orgAt(index))
				assert.isDefined(claimedAt)
				assert.isAtMost(claimedAt!, offset)
				assert.isBelow(offset - claimedAt!, chunkSpanMs + 500)
			})
			assert.isAtLeast(claimOffset.get(orgAt(25))!, chunkSpanMs - 100)
		}).pipe(
			Effect.provide(makeLayer(testDb, stub, { fetch: okFetch, schedulerSpreadMs: () => spreadMs })),
		)
	})

	it.live("a stuck rule holds one lane while the rest keep their slots", () => {
		const testDb = createTestDb(trackedDbs)
		const spreadMs = 1_000
		const firstQueryAt = Ref.makeUnsafe(HashMap.empty<string, number>())
		const { stub } = makeSlowWarehouse((orgId) =>
			Clock.currentTimeMillis.pipe(
				Effect.tap((ms) =>
					Ref.update(firstQueryAt, (starts) =>
						HashMap.has(starts, orgId) ? starts : HashMap.set(starts, orgId, ms),
					),
				),
				Effect.as<EvalDelay>(orgId === orgAt(0) ? "stuck" : Duration.millis(FAST_EVAL_MS)),
			),
		)
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			yield* createPoolRules(alerts)

			const startedAt = yield* Clock.currentTimeMillis
			const tick = yield* alerts.runSchedulerTick()
			const starts = yield* Ref.get(firstQueryAt)

			assert.strictEqual(tick.evaluatedCount, RULE_COUNT)
			assert.strictEqual(tick.deferredCount, 0)
			const slotMs = spreadMs / RULE_COUNT
			const firstStart = Option.getOrThrow(HashMap.get(starts, orgAt(0)))
			Arr.forEach(Arr.range(1, RULE_COUNT - 1), (index) => {
				const offset = Option.getOrThrow(HashMap.get(starts, orgAt(index))) - startedAt
				assert.isAtLeast(offset, index * slotMs)
				assert.isBelow(offset - (firstStart - startedAt), index * slotMs + 500)
			})
			const stuckRule = (yield* alerts.listRules(orgAt(0))).rules[0]!
			assert.include(stuckRule.lastEvaluationError ?? "", "exceeded")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, stub, {
					fetch: okFetch,
					schedulerSpreadMs: () => spreadMs,
					schedulerEvalTimeoutMs: () => 1_500,
				}),
			),
		)
	})

	it.live("keeps at most two rules in flight when the spread outpaces evaluation", () => {
		const testDb = createTestDb(trackedDbs)
		// 40 ms slots against 20 ms evaluations: unpaced, all five lanes fill at once.
		const spreadMs = 2_000
		const inFlight = Ref.makeUnsafe(0)
		const peak = Ref.makeUnsafe(0)
		const base = makeSlowWarehouse(() => Effect.succeed(Duration.millis(FAST_EVAL_MS)))
		const tracked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.acquireUseRelease(
				Ref.updateAndGet(inFlight, (n) => n + 1).pipe(
					Effect.tap((n) => Ref.update(peak, (max) => Math.max(max, n))),
				),
				() => effect,
				() => Ref.update(inFlight, (n) => n - 1),
			)
		const stub: WarehouseQueryServiceApi = {
			...base.stub,
			sqlQuery: (...args) => tracked(base.stub.sqlQuery(...args)),
			rawSqlQuery: (...args) => tracked(base.stub.rawSqlQuery(...args)),
			compiledQuery: (...args) => tracked(base.stub.compiledQuery(...args)),
			compiledQueryWithCapabilities: (...args) =>
				tracked(base.stub.compiledQueryWithCapabilities(...args)),
			compiledQueryFirst: (...args) => tracked(base.stub.compiledQueryFirst(...args)),
		}
		const runTick = (spread: number) =>
			Effect.gen(function* () {
				yield* Ref.set(peak, 0)
				const alerts = yield* AlertsService
				const tick = yield* alerts.runSchedulerTick()
				assert.strictEqual(tick.evaluatedCount, RULE_COUNT)
				return yield* Ref.get(peak)
			}).pipe(
				Effect.provide(makeLayer(testDb, stub, { fetch: okFetch, schedulerSpreadMs: () => spread })),
			)
		return Effect.gen(function* () {
			yield* Effect.gen(function* () {
				yield* createPoolRules(yield* AlertsService)
			}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
			// Each tick is a minute after the last, past every claim's TTL.
			const unpacedPeak = yield* runTick(0)
			yield* Effect.promise(() =>
				testDb.pglite.query(
					`update alert_rule_claims set last_scheduled_at = last_scheduled_at - interval '2 minutes'`,
				),
			)
			const pacedPeak = yield* runTick(spreadMs)

			assert.strictEqual(unpacedPeak, 5)
			assert.isAtMost(pacedPeak, 2)
		})
	})

	it.live(
		"every rule in a tick reads and records the same window, even when the spread crosses a minute",
		() => {
			const testDb = createTestDb(trackedDbs)
			const shiftMs = Ref.makeUnsafe(0)
			const shiftedNow = Effect.zipWith(
				Clock.currentTimeMillis,
				Ref.get(shiftMs),
				(ms, shift) => ms + shift,
			)
			// The latest 'YYYY-MM-DD HH:MM:SS' literal in a rule's SQL is its window end.
			const windowEnds = Ref.makeUnsafe(HashMap.empty<string, string>())
			const recordWindowEnd = (orgId: string, sql: string) =>
				Ref.update(windowEnds, (ends) => {
					const latest = Arr.last(
						Arr.sort(sql.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g) ?? [], Order.String),
					)
					return Option.match(latest, {
						onNone: () => ends,
						onSome: (end) => HashMap.set(ends, orgId, end),
					})
				})
			const base = makeSlowWarehouse(() => Effect.succeed(Duration.millis(FAST_EVAL_MS)))
			const decodeCheckWindow = Schema.decodeUnknownSync(
				Schema.Struct({ WindowStart: Schema.String, WindowEnd: Schema.String }),
			)
			const checkWindows = Ref.makeUnsafe<ReadonlyArray<string>>([])
			const stub: WarehouseQueryServiceApi = {
				...base.stub,
				ingest: (_tenant, datasource, rows) =>
					datasource === "alert_checks"
						? Ref.update(checkWindows, (windows) => [
								...windows,
								...rows.map((row) => {
									const { WindowStart, WindowEnd } = decodeCheckWindow(row)
									return `${WindowStart} - ${WindowEnd}`
								}),
							])
						: Effect.void,
				compiledQuery: (tenant, compiled, ...rest) =>
					recordWindowEnd(tenant.orgId, compiledQueryOf(compiled).sql).pipe(
						Effect.andThen(base.stub.compiledQuery(tenant, compiled, ...rest)),
					),
				compiledQueryWithCapabilities: (tenant, compile, ...rest) =>
					recordWindowEnd(
						tenant.orgId,
						Effect.runSync(compile(baselineWarehouseCapabilities())).sql,
					).pipe(Effect.andThen(base.stub.compiledQueryWithCapabilities(tenant, compile, ...rest))),
			}
			return Effect.gen(function* () {
				const alerts = yield* AlertsService
				yield* createPoolRules(alerts)

				// Start the tick 1.5 s before a minute boundary, so a 2 s spread crosses it.
				const realNow = yield* Clock.currentTimeMillis
				const tickAt = (Math.floor(realNow / 60_000) + 2) * 60_000 - 1_500
				yield* Ref.set(shiftMs, tickAt - realNow)
				const tick = yield* alerts.runSchedulerTick()

				assert.strictEqual(tick.evaluatedCount, RULE_COUNT)
				const ends = Arr.fromIterable(HashMap.values(yield* Ref.get(windowEnds)))
				assert.strictEqual(ends.length, RULE_COUNT)
				assert.deepStrictEqual(Arr.dedupe(ends), [formatWarehouseDateTime(tickAt - 58_500)])
				// The audit rows name that same window, not each rule's later claim time.
				const windows = yield* Ref.get(checkWindows)
				assert.strictEqual(windows.length, RULE_COUNT)
				assert.lengthOf(Arr.dedupe(windows), 1)
				assert.include(windows[0]!, formatWarehouseDateTime(tickAt - 58_500))
			}).pipe(
				Effect.provide(
					makeLayer(testDb, stub, {
						fetch: okFetch,
						now: shiftedNow,
						schedulerSpreadMs: () => 2_000,
					}),
				),
			)
		},
	)

	it.live("stops at the tick deadline and leads the next tick with the deferred rules", () => {
		const testDb = createTestDb(trackedDbs)
		const tickBudgetMs = 1_500
		const shiftMs = Ref.makeUnsafe(0)
		// Slow on every tick, so no tick reaches all rules and only the order decides
		// which rules a tick reaches.
		const { stub, queried } = makeSlowWarehouse((orgId) =>
			Effect.succeed<EvalDelay>(orgId === orgAt(0) ? "stuck" : Duration.millis(200)),
		)
		const overrides = {
			fetch: okFetch,
			now: Effect.zipWith(Clock.currentTimeMillis, Ref.get(shiftMs), (ms, shift) => ms + shift),
			schedulerTickBudgetMs: () => tickBudgetMs,
			schedulerEvalTimeoutMs: () => 800,
		}
		const { spans, tracer } = makeRecordingTracer()
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			yield* createPoolRules(alerts)

			const startedAt = yield* Clock.currentTimeMillis
			const firstTick = yield* alerts.runSchedulerTick().pipe(Effect.withTracer(tracer))
			const wallMs = (yield* Clock.currentTimeMillis) - startedAt

			// The deferred rules are counted on the tick span, where tick dashboards look.
			assert.isAbove(firstTick.deferredCount, 0)
			assert.deepStrictEqual(
				spansNamed(spans, "AlertsService.runSchedulerTick").map((span) =>
					span.attributes.get("maple.alerting.rules_deferred"),
				),
				[firstTick.deferredCount],
			)

			// Slack for a loaded CI runner; without the deadline the stuck rule never returns.
			assert.isBelow(wallMs, tickBudgetMs + 2_500)
			assert.isBelow(HashSet.size(yield* queried), RULE_COUNT)
			assert.strictEqual(firstTick.evaluatedCount, HashSet.size(yield* queried))
			const stuckRule = (yield* alerts.listRules(orgAt(0))).rules[0]!
			assert.include(stuckRule.lastEvaluationError ?? "", "deadline")

			// Each tick a minute later, past every claim's TTL. Five more ticks leave
			// room for a slow runner; an order that keeps deferring the same tail
			// never reaches every rule, however many ticks run.
			yield* Effect.forEach(
				[1, 2, 3, 4, 5],
				() =>
					Ref.update(shiftMs, (shift) => shift + 60_000).pipe(
						Effect.andThen(alerts.runSchedulerTick()),
					),
				{ discard: true },
			)

			assert.strictEqual(HashSet.size(yield* queried), RULE_COUNT)
		}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))
	})
})

describe("AlertsService claim fence", () => {
	const groupRow = (groupName: string, errorRate: number) =>
		tracesRow({ groupName, count: 200, errorRate, estimatedSpanCount: 200 })

	it.effect(
		"a tick whose claim expired mid-notification leaves the rule to the tick that re-claimed it",
		() => {
			const testDb = createTestDb(trackedDbs)
			const rows = Ref.makeUnsafe<ReadonlyArray<Record<string, unknown>>>([
				groupRow("checkout", 42),
				groupRow("payments", 42),
			])
			// Shifts the scheduler clock without moving TestClock, so timeouts already
			// armed inside the tick never fire.
			const shiftMs = Ref.makeUnsafe(0)
			// One-shot hooks: the next evaluation query and the next chart-series read
			// (the notification's enrichment) run these first.
			const onEvaluation = Ref.makeUnsafe<Effect.Effect<void>>(Effect.void)
			const onChartSeries = Ref.makeUnsafe<Effect.Effect<void>>(Effect.void)
			const runHook = (hook: Ref.Ref<Effect.Effect<void>>) =>
				Effect.flatten(Ref.getAndSet(hook, Effect.void))

			const base = makeWarehouseStub({})
			const evaluationRows = () => runHook(onEvaluation).pipe(Effect.andThen(Ref.get(rows)))
			const stub: WarehouseQueryServiceApi = {
				...base,
				compiledQuery: (_tenant, compiled, options) =>
					options?.context === "alertChartSeries"
						? runHook(onChartSeries).pipe(
								Effect.andThen(compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie)),
							)
						: evaluationRows().pipe(
								Effect.flatMap((r) =>
									compiledQueryOf(compiled).decodeRows(r).pipe(Effect.orDie),
								),
							),
				compiledQueryWithCapabilities: (_tenant, compile) =>
					evaluationRows().pipe(
						Effect.flatMap((r) =>
							Effect.runSync(compile(baselineWarehouseCapabilities()))
								.decodeRows(r)
								.pipe(Effect.orDie),
						),
					),
			}
			const overrides = {
				fetch: okFetch,
				now: Effect.zipWith(Clock.currentTimeMillis, Ref.get(shiftMs), (ms, shift) => ms + shift),
			}

			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_claim_fence")
				const userId = asUserId("user_claim_fence")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* alerts.createRule(
					orgId,
					userId,
					adminRoles,
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

				yield* alerts.runSchedulerTick()
				assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 2)

				// Both groups recover. The first tick's warehouse result is late (20s), and
				// its first resolve notification is slow (another 20s): 40s after the
				// claim, past SCHEDULER_LOCK_TTL_MS. During that notification a second
				// tick re-claims the rule and resolves the group the first one has not
				// reached yet.
				yield* Ref.set(rows, [groupRow("checkout", 0.5), groupRow("payments", 0.5)])
				yield* TestClock.adjust(Duration.minutes(1))
				const firstClaimAt = DEFAULT_CLOCK_EPOCH_MS + 60_000
				const secondClaimAt = firstClaimAt + 40_000
				yield* Ref.set(
					onEvaluation,
					Ref.update(shiftMs, (shift) => shift + 20_000),
				)
				yield* Ref.set(
					onChartSeries,
					Ref.update(shiftMs, (shift) => shift + 20_000).pipe(
						Effect.andThen(alerts.runSchedulerTick()),
						Effect.asVoid,
						Effect.orDie,
					),
				)
				yield* alerts.runSchedulerTick()

				const incidents = (yield* alerts.listIncidents(orgId)).incidents
				assert.deepStrictEqual(
					incidents.map((incident) => incident.status),
					["resolved", "resolved"],
				)
				// Each group resolved once, by one tick each: the first tick stopped at
				// the group the second tick had already resolved.
				assert.sameMembers(
					incidents.map((incident) => incident.resolvedAt),
					[new Date(firstClaimAt).toISOString(), new Date(secondClaimAt).toISOString()],
				)
				const resolveEvents = (yield* alerts.listDeliveryEvents(orgId)).events.filter(
					(event) => event.eventType === "resolve",
				)
				assert.sameMembers(
					resolveEvents.map((event) => event.incidentId),
					incidents.map((incident) => incident.id),
				)

				const lateGroup = incidents.find(
					(incident) => incident.resolvedAt === new Date(secondClaimAt).toISOString(),
				)!.groupKey
				const lateState = yield* Effect.promise(() =>
					queryFirstRow<{ lastEvaluatedAt: Date | null; consecutiveHealthy: number }>(
						testDb,
						`select last_evaluated_at as "lastEvaluatedAt", consecutive_healthy as "consecutiveHealthy"
					   from alert_rule_states where rule_id = $1 and group_key = $2`,
						[rule.id, lateGroup],
					),
				)
				assert.strictEqual(lateState?.lastEvaluatedAt?.getTime(), secondClaimAt)
			}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))
		},
	)
})

describe("AlertsService fenced state flush", () => {
	// One healthy ungrouped rule: no transition, so its only write is the state flush.
	// `during` runs raw SQL on the database while the rule's evaluation is in flight.
	const flushWith = (during: string) => {
		const testDb = createTestDb(trackedDbs)
		const hook = Ref.makeUnsafe(false)
		const base = makeWarehouseStub({
			tracesAggregateRows: [tracesRow({ count: 200, errorRate: 1, estimatedSpanCount: 200 })],
		})
		const interfere = Effect.flatMap(Ref.getAndSet(hook, false), (armed) =>
			armed ? Effect.promise(() => testDb.pglite.exec(during)) : Effect.void,
		)
		const stub: WarehouseQueryServiceApi = {
			...base,
			compiledQueryWithCapabilities: (tenant, compile, options) =>
				Effect.andThen(interfere, base.compiledQueryWithCapabilities(tenant, compile, options)),
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_fenced_flush")
			const userId = asUserId("user_fenced_flush")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			yield* Ref.set(hook, true)
			yield* alerts.runSchedulerTick()
			const states = yield* Effect.promise(() =>
				queryFirstRow<{ n: number }>(
					testDb,
					"select count(*)::int as n from alert_rule_states where rule_id = $1",
					[rule.id],
				),
			)
			return { stateRows: states?.n ?? 0 }
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
	}

	it.effect("writes the state rows while the claim and the rule are unchanged", () =>
		Effect.map(flushWith("select 1"), ({ stateRows }) => assert.strictEqual(stateRows, 1)),
	)

	it.effect("writes nothing once a later tick has re-claimed the rule", () =>
		Effect.map(
			flushWith(
				"update alert_rule_claims set last_scheduled_at = last_scheduled_at + interval '30 seconds'",
			),
			({ stateRows }) => assert.strictEqual(stateRows, 0),
		),
	)

	it.effect("writes nothing once the rule was edited after the tick loaded it", () =>
		Effect.map(
			flushWith("update alert_rules set updated_at = updated_at + interval '1 second'"),
			({ stateRows }) => assert.strictEqual(stateRows, 0),
		),
	)
})

describe("AlertsService post-evaluation writes", () => {
	const GROUPS = 30
	const EXECUTE_DELAY_MS = 100

	// Every `Database.execute` waits first, like a Hyperdrive round trip at peak.
	const slowDb = (testDb: TestDb): TestDb => ({
		...testDb,
		layer: Layer.effect(
			Database,
			Effect.gen(function* () {
				const inner = yield* Database
				return Database.of({
					execute: (fn) =>
						Effect.sleep(Duration.millis(EXECUTE_DELAY_MS)).pipe(
							Effect.andThen(inner.execute(fn)),
						),
				})
			}),
		).pipe(Layer.provide(testDb.layer)),
	})

	it.live("writes a grouped rule's state rows in one batch, not one transaction per group", () => {
		const testDb = createTestDb(trackedDbs)
		const services = Arr.makeBy(GROUPS, (index) => `svc-${String(index).padStart(2, "0")}`)
		const stub = makeWarehouseStub({
			tracesAggregateRows: services.map((groupName) =>
				tracesRow({ groupName, count: 200, errorRate: 0.5, estimatedSpanCount: 200 }),
			),
		})
		const { spans, tracer } = makeRecordingTracer()

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_state_batch")
			const userId = asUserId("user_state_batch")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Grouped error rate",
					severity: "warning",
					enabled: true,
					groupBy: ["service.name"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					destinationIds: [destination.id],
				}),
			)

			const startedAt = yield* Clock.currentTimeMillis
			const tick = yield* alerts.runSchedulerTick().pipe(Effect.withTracer(tracer))
			const wallMs = (yield* Clock.currentTimeMillis) - startedAt

			assert.strictEqual(tick.evaluatedCount, 1)
			// One transaction per group would spend GROUPS * EXECUTE_DELAY_MS on writes alone.
			assert.isBelow(wallMs, GROUPS * EXECUTE_DELAY_MS)
			const flushes = spansNamed(spans, "AlertsService.flushRuleStates")
			assert.deepStrictEqual(
				flushes.map((span) => span.attributes.get("maple.alerting.state_rows")),
				[GROUPS],
			)

			const stored = yield* Effect.promise(() =>
				queryFirstRow<{ groups: number; healthy: number }>(
					testDb,
					`select count(*)::int as "groups",
					        count(*) filter (where last_status = 'healthy' and consecutive_healthy = 1)::int as "healthy"
					   from alert_rule_states where rule_id = $1`,
					[rule.id],
				),
			)
			assert.deepStrictEqual(stored, { groups: GROUPS, healthy: GROUPS })
		}).pipe(Effect.provide(makeLayer(slowDb(testDb), stub, { fetch: okFetch })))
	})

	it.live("retries a state flush that failed on a transient error", () => {
		const testDb = createTestDb(trackedDbs)
		const services = ["svc-a", "svc-b", "svc-c"]
		const stub = makeWarehouseStub({
			tracesAggregateRows: services.map((groupName) =>
				tracesRow({ groupName, count: 200, errorRate: 0.5, estimatedSpanCount: 200 }),
			),
		})
		const flushFailures = Ref.makeUnsafe(1)
		// The flush's first transaction fails like a dropped connection, which
		// the contention retry inside dbExecute does not cover.
		const flakyFlushDb: TestDb = {
			...testDb,
			layer: Layer.effect(
				Database,
				Effect.gen(function* () {
					const inner = yield* Database
					return Database.of({
						execute: (fn) =>
							Effect.gen(function* () {
								const span = yield* Effect.currentSpan.pipe(Effect.orElseSucceed(() => null))
								const fail =
									span?.name === "AlertsService.flushRuleStates" &&
									(yield* Ref.modify(flushFailures, (left) => [
										left > 0,
										Math.max(0, left - 1),
									]))
								if (fail) {
									return yield* new DatabaseError({
										message: "Connection terminated unexpectedly",
										cause: null,
									})
								}
								return yield* inner.execute(fn)
							}),
					})
				}),
			).pipe(Layer.provide(testDb.layer)),
		}

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_state_batch_retry")
			const userId = asUserId("user_state_batch_retry")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Grouped error rate",
					severity: "warning",
					enabled: true,
					groupBy: ["service.name"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					destinationIds: [destination.id],
				}),
			)

			yield* alerts.runSchedulerTick()

			assert.strictEqual(yield* Ref.get(flushFailures), 0, "the flush failed once")
			const stored = yield* Effect.promise(() =>
				queryFirstRow<{ healthy: number }>(
					testDb,
					`select count(*) filter (where last_status = 'healthy')::int as "healthy"
					   from alert_rule_states where rule_id = $1`,
					[rule.id],
				),
			)
			assert.deepStrictEqual(stored, { healthy: services.length })
		}).pipe(Effect.provide(makeLayer(flakyFlushDb, stub, { fetch: okFetch })))
	})

	it.effect("a rule edited before its flush keeps neither the buffered states nor their checks", () => {
		const testDb = createTestDb(trackedDbs)
		const services = ["svc-a", "svc-b", "svc-c"]
		const base = makeWarehouseStub({
			tracesAggregateRows: services.map((groupName) =>
				tracesRow({ groupName, count: 200, errorRate: 0.5, estimatedSpanCount: 200 }),
			),
		})
		const ingested: Array<Record<string, unknown>> = []
		// The rule to disable on the next warehouse query: set once the rule
		// exists, cleared by the edit so it runs once.
		const pendingEdit = Ref.makeUnsafe<string | null>(null)
		// An admin disables the rule while its evaluation is in flight, after the
		// tick loaded the rule and before the groups' state rows are flushed.
		const disableRule = Ref.getAndSet(pendingEdit, null).pipe(
			Effect.flatMap((ruleId) =>
				ruleId === null
					? Effect.void
					: Effect.promise(() =>
							queryFirstRow(
								testDb,
								`update alert_rules set enabled = false, updated_at = updated_at + interval '1 second'
								  where id = $1 returning id`,
								[ruleId],
							),
						),
			),
		)
		const stub: WarehouseQueryServiceApi = {
			...base,
			compiledQuery: (tenant, compiled) =>
				disableRule.pipe(Effect.andThen(base.compiledQuery(tenant, compiled))),
			compiledQueryWithCapabilities: (tenant, compile) =>
				disableRule.pipe(Effect.andThen(base.compiledQueryWithCapabilities(tenant, compile))),
			ingest: (_tenant, _datasource, rows) =>
				Effect.sync(() => {
					ingested.push(...(rows as Array<Record<string, unknown>>))
				}),
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_state_batch_edit")
			const userId = asUserId("user_state_batch_edit")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Grouped error rate",
					severity: "warning",
					enabled: true,
					groupBy: ["service.name"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					destinationIds: [destination.id],
				}),
			)
			yield* Ref.set(pendingEdit, rule.id)

			yield* alerts.runSchedulerTick()

			assert.isNull(yield* Ref.get(pendingEdit), "the edit ran during the tick")
			const stored = yield* Effect.promise(() =>
				queryFirstRow<{ healthy: number }>(
					testDb,
					`select count(*) filter (where last_status = 'healthy')::int as "healthy"
					   from alert_rule_states where rule_id = $1`,
					[rule.id],
				),
			)
			assert.deepStrictEqual(stored, { healthy: 0 })
			assert.deepStrictEqual(
				ingested.filter((row) => row.RuleId === rule.id && row.Status === "healthy"),
				[],
			)
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
	})
})

describe("AlertsService investigation starts", () => {
	// One grouped rule whose `groupCount` groups all breach on the first tick, with
	// triage enabled, and a chat port that records each investigation turn it starts.
	const setupTriageStorm = (
		testDb: TestDb,
		groupCount: number,
		adapt: {
			readonly stub?: (stub: WarehouseQueryServiceApi) => WarehouseQueryServiceApi
			readonly now?: Effect.Effect<number>
		} = {},
	) => {
		const groups = Arr.makeBy(groupCount, (i) => `svc-${i}`)
		const alertRows: ReadonlyArray<Record<string, unknown>> = groups.map((groupName) =>
			tracesRow({ groupName, count: 200, errorRate: 10, satisfiedCount: 180, estimatedSpanCount: 200 }),
		)
		const baseStub = makeWarehouseStub({ tracesAggregateRows: alertRows })
		const stub = adapt.stub ? adapt.stub(baseStub) : baseStub
		const turns: Array<string> = []
		const chatSessions = fakeChatSessions(() => ({
			beginTurn: async (input: { sessionId: string; messageId: string }) => {
				turns.push(input.sessionId)
				return { cursor: 0, messageId: input.messageId, turnMessageId: input.messageId }
			},
		}))
		const createRule = Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_triage_storm")
			const userId = asUserId("user_triage_storm")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Every service error rate",
					severity: "critical",
					enabled: true,
					groupBy: ["service.name"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 1,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
				}),
			)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"insert into ai_triage_settings (org_id, enabled, max_runs_per_day, updated_at) values ($1, true, 100, now())",
					[orgId],
				),
			)
			return { alerts, orgId, rule }
		})
		const committedStates = (ruleId: string) =>
			Effect.promise(() =>
				queryFirstRow<{ n: number }>(
					testDb,
					"select count(*)::int as n from alert_rule_states where rule_id = $1",
					[ruleId],
				),
			).pipe(Effect.map((row) => row?.n ?? 0))
		const layer = makeLayer(testDb, stub, {
			fetch: okFetch,
			chatSessions,
			now: adapt.now ?? Clock.currentTimeMillis,
		})
		return { groups, turns, createRule, committedStates, layer }
	}

	it.effect("starts a grouped rule's investigations after its state is written, several at once", () => {
		const testDb = createTestDb(trackedDbs)
		const { groups, turns, createRule, committedStates, layer } = setupTriageStorm(testDb, 12)

		return Effect.gen(function* () {
			const { alerts, orgId, rule } = yield* createRule
			// What the classifier sees when it is called: how many of the rule's groups have a
			// committed state row, and how many classifications are in flight with it.
			const inFlight = yield* Ref.make(0)
			const peakInFlight = yield* Ref.make(0)
			const statesAtFirstCall = yield* Ref.make<number | null>(null)
			const classifier = Layer.succeed(IncidentClassifier, {
				classify: () =>
					Effect.gen(function* () {
						const states = yield* committedStates(rule.id)
						yield* Ref.update(statesAtFirstCall, (seen) => seen ?? states)
						const current = yield* Ref.updateAndGet(inFlight, (n) => n + 1)
						yield* Ref.update(peakInFlight, (peak) => Math.max(peak, current))
						yield* Effect.yieldNow.pipe(Effect.repeat({ times: 5 }))
						yield* Ref.update(inFlight, (n) => n - 1)
						return null
					}),
			})

			yield* alerts.runSchedulerTick().pipe(Effect.provide(classifier))

			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, groups.length)
			assert.lengthOf(turns, groups.length)
			assert.strictEqual(yield* Ref.get(statesAtFirstCall), groups.length)
			assert.isAbove(yield* Ref.get(peakInFlight), 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("starts every queued investigation when the triage phase runs past the claim TTL", () => {
		const testDb = createTestDb(trackedDbs)
		// The production storm: one rule opening 34 incidents.
		const { groups, turns, createRule, committedStates, layer } = setupTriageStorm(testDb, 34)

		return Effect.gen(function* () {
			const { alerts, rule } = yield* createRule
			const firstCall = yield* Ref.make<{ elapsedMs: number; states: number } | null>(null)
			// Every classification takes the classifier's full 10 s timeout, so the phase
			// runs far past tick start + 30 s.
			const classifier = Layer.succeed(IncidentClassifier, {
				classify: () =>
					Effect.gen(function* () {
						const elapsedMs = (yield* Clock.currentTimeMillis) - DEFAULT_CLOCK_EPOCH_MS
						const states = yield* committedStates(rule.id)
						yield* Ref.update(firstCall, (seen) => seen ?? { elapsedMs, states })
						yield* TestClock.adjust("10 seconds")
						return null
					}),
			})

			yield* alerts.runSchedulerTick().pipe(Effect.provide(classifier))

			const seen = yield* Ref.get(firstCall)
			assert.isNotNull(seen)
			assert.strictEqual(seen?.states, groups.length)
			assert.isBelow(seen?.elapsedMs ?? Infinity, 1_000)
			assert.isAbove((yield* Clock.currentTimeMillis) - DEFAULT_CLOCK_EPOCH_MS, 30_000)
			assert.lengthOf(turns, groups.length)
		}).pipe(Effect.provide(layer))
	})

	it.effect("releases the tick's unstarted claims before triage begins", () => {
		const testDb = createTestDb(trackedDbs)
		// Every warehouse answer moves the scheduler's clock a minute on, so once the first
		// evaluations return, the rules still waiting for a lane pass the tick deadline.
		const shiftMs = Ref.makeUnsafe(0)
		const advance = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.tap(effect, () => Ref.update(shiftMs, (shift) => shift + 60_000))
		const { turns, createRule, layer } = setupTriageStorm(testDb, 3, {
			now: Effect.zipWith(Clock.currentTimeMillis, Ref.get(shiftMs), (ms, shift) => ms + shift),
			stub: (base) => ({
				...base,
				compiledQuery: (...args) => advance(base.compiledQuery(...args)),
				compiledQueryWithCapabilities: (...args) =>
					advance(base.compiledQueryWithCapabilities(...args)),
				compiledQueryFirst: (...args) => advance(base.compiledQueryFirst(...args)),
			}),
		})
		const { spans, tracer } = makeRecordingTracer()

		return Effect.gen(function* () {
			const { alerts } = yield* createRule
			// Created after the storm rule, so the scheduler reaches them later: more rules
			// than lanes, in an org without triage.
			const otherOrg = asOrgId("org_triage_other")
			const destination = yield* createWebhookDestination(alerts, otherOrg, asUserId("user_other"))
			yield* Effect.forEach(
				Arr.range(1, 6),
				(index) =>
					TestClock.adjust("2 millis").pipe(
						Effect.andThen(
							alerts.createRule(
								otherOrg,
								asUserId("user_other"),
								adminRoles,
								new AlertRuleUpsertRequest({
									name: `Other rule ${index}`,
									severity: "warning",
									enabled: true,
									signalType: "error_rate",
									comparator: "gt",
									threshold: 99,
									windowMinutes: 5,
									destinationIds: [destination.id],
								}),
							),
						),
					),
				{ discard: true },
			)
			// Whether the release had finished each time the triage phase opened.
			const releasedAtTriageStart: Array<boolean> = []
			const classifier = Layer.succeed(IncidentClassifier, { classify: () => Effect.succeed(null) })
			const recording = Tracer.make({
				span(options) {
					if (options.name === "AlertsService.startPendingTriages") {
						releasedAtTriageStart.push(
							spansNamed(spans, "AlertsService.releaseClaims").some(
								(span) => span.status._tag === "Ended",
							),
						)
					}
					return tracer.span(options)
				},
			})

			const tick = yield* alerts
				.runSchedulerTick()
				.pipe(Effect.provide(classifier), Effect.withTracer(recording))

			assert.isAbove(tick.deferredCount, 0)
			assert.deepStrictEqual(releasedAtTriageStart, [true])
			assert.lengthOf(turns, 3)
		}).pipe(Effect.provide(layer))
	})
})
