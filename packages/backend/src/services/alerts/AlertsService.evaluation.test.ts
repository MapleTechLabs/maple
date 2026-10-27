// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { AlertValidationError, WarehouseQuotaExceededError } from "@maple/domain/http"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Duration, Effect, Layer, Logger, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	type AlertDestinationId,
	AlertRulePreviewRequest,
	AlertRuleUpsertRequest,
	WarehouseQueryError,
	WarehouseUpstreamError,
} from "@maple/domain/http"
import type { WarehouseQueryServiceApi } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { AlertsService, type AlertsServiceApi } from "./AlertsService"
import { baselineWarehouseCapabilities } from "@maple/query-engine"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { compiledQueryOf } from "@maple/query-engine/execution"
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

describe("AlertsService evaluation error persistence", () => {
	const failingWarehouseStub = (state: {
		failing: boolean
		rows: ReadonlyArray<Record<string, unknown>>
		ingested: Array<Record<string, unknown>>
		failure?: WarehouseQueryError | WarehouseUpstreamError
	}): WarehouseQueryServiceApi => {
		const sqlQueryStub = () =>
			state.failing
				? Effect.fail(
						state.failure ??
							new WarehouseQueryError({
								message: "Unknown column FooBar in traces",
								pipeName: "tracesAlertEval",
							}),
					)
				: Effect.succeed(state.rows)
		return {
			query: () => Effect.die(new Error("Unexpected pipe query")),
			sqlQuery: sqlQueryStub,
			rawSqlQuery: sqlQueryStub,
			compiledQuery: (_tenant, compiled) =>
				sqlQueryStub().pipe(
					Effect.flatMap((rows) => compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)),
				),
			compiledQueryWithCapabilities: (_tenant, compile) =>
				sqlQueryStub().pipe(
					Effect.flatMap((rows) =>
						Effect.runSync(compile(baselineWarehouseCapabilities()))
							.decodeRows(rows)
							.pipe(Effect.orDie),
					),
				),
			compiledQueryFirst: (_tenant, compiled) =>
				sqlQueryStub().pipe(
					Effect.flatMap((rows) =>
						compiledQueryOf(compiled).decodeFirstRow(rows).pipe(Effect.orDie),
					),
				),
			ingest: (_tenant, _datasource, rows) =>
				Effect.sync(() => {
					state.ingested.push(...(rows as Array<Record<string, unknown>>))
				}),
			asExecutor: () => {
				throw new Error("asExecutor is not supported by this test stub")
			},
		}
	}

	it.effect("retries a failed long-window rule on the next tick, then settles onto its interval", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			rows: [] as ReadonlyArray<Record<string, unknown>>,
			ingested: [] as Array<Record<string, unknown>>,
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_retry")
			const userId = asUserId("user_alert_retry")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Retry rule",
					severity: "warning",
					enabled: true,
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 30,
					destinationIds: [destination.id],
				}),
			)
			const tickAndCount = Effect.gen(function* () {
				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
				return state.ingested.length
			})

			// Two failing ticks then a clean one, each a minute apart.
			const failing = yield* Effect.forEach(Arr.range(1, 2), () => tickAndCount)
			state.failing = false
			const recovered = yield* tickAndCount
			assert.deepStrictEqual([...failing, recovered], [1, 2, 3])
			// Healthy again, it waits for its 5-minute slot.
			const later = yield* Effect.forEach(Arr.range(1, 4), () => tickAndCount)
			assert.isBelow(later[3]! - recovered, 4)
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("persists scheduler failures to lastError + audit log, gated, and clears on recovery", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			rows: [
				tracesRow({
					count: 200,
					avgDuration: 40,
					p50Duration: 20,
					p95Duration: 120,
					p99Duration: 240,
					errorRate: 1,
					satisfiedCount: 180,
					toleratingCount: 10,
					apdexScore: 0.925,
				}),
			],
			ingested: [] as Array<Record<string, unknown>>,
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_errors")
			const userId = asUserId("user_alert_errors")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			// Failing tick: the error must land in alert_rule_states.lastError, be
			// surfaced on listRules, and produce an "error" audit check row.
			yield* alerts.runSchedulerTick()

			const rulesWhileFailing = yield* alerts.listRules(orgId)
			assert.strictEqual(
				rulesWhileFailing.rules[0]?.lastEvaluationError,
				"Unknown column FooBar in traces",
			)
			const errorChecks = state.ingested.filter((row) => row.Status === "error")
			assert.lengthOf(errorChecks, 1)
			assert.strictEqual(errorChecks[0]?.ErrorMessage, "Unknown column FooBar in traces")
			assert.strictEqual(errorChecks[0]?.ErrorCategory, "warehouse_query_failed")
			assert.strictEqual(errorChecks[0]?.GroupKey, "__total__")
			assert.strictEqual(errorChecks[0]?.SkipReason, "")

			const stateAfterFirstFailure = yield* Effect.promise(() =>
				queryFirstRow<{ updated_at: Date }>(
					testDb,
					"select updated_at from alert_rule_states where rule_id = $1 and group_key = '__total__'",
					[rule.id],
				),
			)
			assert.isDefined(stateAfterFirstFailure)

			// Second failing tick with the SAME message inside the heartbeat window:
			// churn-gated, so the Electric-synced state row must NOT be rewritten.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const stateAfterSecondFailure = yield* Effect.promise(() =>
				queryFirstRow<{ updated_at: Date }>(
					testDb,
					"select updated_at from alert_rule_states where rule_id = $1 and group_key = '__total__'",
					[rule.id],
				),
			)
			assert.strictEqual(
				stateAfterSecondFailure?.updated_at.getTime(),
				stateAfterFirstFailure?.updated_at.getTime(),
			)

			// Recovery: a clean evaluation clears the stored error.
			state.failing = false
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const rulesAfterRecovery = yield* alerts.listRules(orgId)
			assert.isNull(rulesAfterRecovery.rules[0]?.lastEvaluationError)
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("skips rules on a warehouse outage without counting failures, warning once per org", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			rows: [],
			ingested: [] as Array<Record<string, unknown>>,
			failure: new WarehouseUpstreamError({
				message: "HTTP 503",
				pipeName: "tracesAlertEval",
				upstreamStatus: 503,
			}),
		}
		const logs: Array<{ readonly message: string; readonly level: string }> = []
		const captureLogs = Logger.layer([
			Logger.make(({ message, logLevel }) => {
				logs.push({ message: String(message), level: logLevel })
			}),
		])

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_outage")
			const userId = asUserId("user_alert_outage")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id, "Outage rule A")
			yield* createErrorRateRule(alerts, orgId, userId, destination.id, "Outage rule B")

			const tick = yield* alerts.runSchedulerTick()

			assert.strictEqual(tick.evaluationFailureCount, 0)
			assert.strictEqual(tick.warehouseUnavailableSkipCount, 2)
			assert.lengthOf(
				logs.filter((log) => log.message.includes("Alert rule evaluation failed")),
				0,
			)
			const outageWarnings = logs.filter((log) =>
				log.message.includes("Alert rule evaluations skipped: warehouse unavailable"),
			)
			assert.lengthOf(outageWarnings, 1)
			assert.strictEqual(outageWarnings[0]?.level, "Warn")
			// The check history still shows the gap, labelled as an outage.
			const checks = state.ingested.filter((row) => row.Status === "error")
			assert.lengthOf(checks, 2)
			assert.isTrue(checks.every((row) => row.ErrorCategory === "warehouse_unavailable"))
			const rules = yield* alerts.listRules(orgId)
			// Not the rule's fault, so the rule is not flagged as failing.
			assert.isTrue(rules.rules.every((rule) => rule.lastEvaluationError === null))
		}).pipe(
			Effect.provide(
				Layer.merge(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch }), captureLogs),
			),
		)
	})

	it.effect("skips the rest of an org's rules once its warehouse is down this tick", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			rows: [],
			ingested: [] as Array<Record<string, unknown>>,
			failure: new WarehouseUpstreamError({
				message: "HTTP 503",
				pipeName: "tracesAlertEval",
				upstreamStatus: 503,
			}),
		}
		const base = failingWarehouseStub(state)
		let warehouseQueries = 0
		const counted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.suspend(() => {
				warehouseQueries += 1
				return effect
			})
		const stub: WarehouseQueryServiceApi = {
			...base,
			sqlQuery: (...args) => counted(base.sqlQuery(...args)),
			rawSqlQuery: (...args) => counted(base.rawSqlQuery(...args)),
			compiledQuery: (...args) => counted(base.compiledQuery(...args)),
			compiledQueryWithCapabilities: (...args) => counted(base.compiledQueryWithCapabilities(...args)),
			compiledQueryFirst: (...args) => counted(base.compiledQueryFirst(...args)),
		}
		const ruleCount = 8

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_outage_breaker")
			const userId = asUserId("user_alert_outage_breaker")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			for (const n of Array.from({ length: ruleCount }, (_, i) => i)) {
				yield* createErrorRateRule(alerts, orgId, userId, destination.id, `Outage rule ${n}`)
			}

			const tick = yield* alerts.runSchedulerTick()

			// Every rule is accounted for as an outage skip, none as the rule's fault.
			assert.strictEqual(tick.warehouseUnavailableSkipCount, ruleCount)
			assert.strictEqual(tick.evaluationFailureCount, 0)
			// Only the rules already in flight when the first failure landed queried
			// the warehouse; the rest were skipped without waiting on it.
			assert.isBelow(warehouseQueries, ruleCount)
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
	})

	it.effect("still counts a 4xx upstream rejection as an evaluation failure", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			rows: [],
			ingested: [] as Array<Record<string, unknown>>,
			failure: new WarehouseUpstreamError({
				message: "HTTP 429",
				pipeName: "tracesAlertEval",
				upstreamStatus: 429,
			}),
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_rejected")
			const userId = asUserId("user_alert_rejected")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			const tick = yield* alerts.runSchedulerTick()

			assert.strictEqual(tick.evaluationFailureCount, 1)
			assert.strictEqual(tick.warehouseUnavailableSkipCount, 0)
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("opens an incident on empty windows when the rule alerts on no data", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { failing: false, rows: [], ingested: [] as Array<Record<string, unknown>> }

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_on_no_data")
			const userId = asUserId("user_alert_on_no_data")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Checkout goes blind",
					severity: "critical",
					serviceNames: ["checkout"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 1,
					alertOnNoData: true,
					destinationIds: [destination.id],
				}),
			)
			assert.strictEqual(rule.noDataBehavior, "alert")

			yield* alerts.runSchedulerTick()

			const breached = state.ingested.filter((row) => row.Status === "breached")
			assert.lengthOf(breached, 1)
			assert.isNull(breached[0]?.ObservedValue)
			assert.strictEqual(breached[0]?.IncidentTransition, "opened")
			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.status, "open")
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("keeps alertOnNoData on a low-throughput rule and rejects it on a grouped one", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { failing: false, rows: [], ingested: [] as Array<Record<string, unknown>> }

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_on_no_data_shapes")
			const userId = asUserId("user_alert_on_no_data_shapes")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const request = (fields: Partial<ConstructorParameters<typeof AlertRuleUpsertRequest>[0]>) =>
				new AlertRuleUpsertRequest({
					name: "No data shapes",
					severity: "critical",
					signalType: "throughput",
					comparator: "lt",
					threshold: 10,
					windowMinutes: 5,
					minimumSampleCount: 50,
					consecutiveBreachesRequired: 1,
					alertOnNoData: true,
					destinationIds: [destination.id],
					...fields,
				})

			// Read as zero, an empty window would be skipped under the minimum; alert wins.
			const throughput = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				request({ serviceNames: ["checkout"] }),
			)
			assert.strictEqual(throughput.noDataBehavior, "alert")
			yield* alerts.runSchedulerTick()
			assert.lengthOf(
				state.ingested.filter((row) => row.Status === "breached" && row.ObservedValue === null),
				1,
			)

			const grouped = yield* alerts
				.createRule(
					orgId,
					userId,
					adminRoles,
					request({ name: "Grouped", groupBy: ["service.name"] }),
				)
				.pipe(Effect.flip)
			assert.instanceOf(grouped, AlertValidationError)
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("records why a check skipped when the window has no data", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { failing: false, rows: [], ingested: [] as Array<Record<string, unknown>> }

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_skip_reason")
			const userId = asUserId("user_alert_skip_reason")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()

			const skipped = state.ingested.filter((row) => row.Status === "skipped")
			assert.lengthOf(skipped, 1)
			assert.strictEqual(skipped[0]?.SkipReason, "no_data")
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})
})

describe("AlertsService.previewRule", () => {
	const decodePreviewRequest = Schema.decodeUnknownSync(AlertRulePreviewRequest)

	const bucketRow = (bucket: string, errorRate: number) =>
		tracesRow({
			bucket,
			count: 200,
			avgDuration: 40,
			p50Duration: 20,
			p95Duration: 120,
			p99Duration: 240,
			errorRate,
			satisfiedCount: 180,
			toleratingCount: 10,
			apdexScore: 0.925,
		})

	it.effect("returns evaluator-bucketed points and would-fire spans for a spec rule", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
				bucketRow("2026-01-01 00:00:00", 10),
				bucketRow("2026-01-01 00:05:00", 12),
				bucketRow("2026-01-01 00:10:00", 1),
			],
		}

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview")

			// No destinations picked yet — preview must not require them.
			const request = decodePreviewRequest({
				rule: {
					name: "Preview rule",
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
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-01T00:30:00.000Z",
			})

			const response = yield* alerts.previewRule(orgId, adminRoles, request)

			assert.strictEqual(response.bucketSeconds, 300)
			assert.strictEqual(response.windowMinutes, 5)
			assert.lengthOf(response.series, 1)
			const points = response.series[0]!.points
			// 30-minute range at 5-minute windows = 6 evaluation buckets, with the
			// three data-less windows filled in as skipped.
			assert.lengthOf(points, 6)
			assert.strictEqual(points[0]?.status, "breached")
			assert.strictEqual(points[1]?.status, "breached")
			assert.strictEqual(points[2]?.status, "healthy")
			assert.strictEqual(points[3]?.status, "skipped")
			assert.strictEqual(points[0]?.value, 10)
			assert.strictEqual(points[0]?.sampleCount, 200)

			// 2 consecutive breaches required → fires across the first two windows,
			// resolved after 2 consecutive healthy... only 1 healthy then skipped
			// (which freezes counters), so no close within the window either way.
			assert.lengthOf(response.wouldFire, 1)
			assert.strictEqual(response.wouldFire[0]?.start, "2026-01-01T00:00:00.000Z")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("covers the whole requested range for the create form's default shape", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: [bucketRow("2026-01-01 00:00:00", 10)] }

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview_full_range")

			const request = decodePreviewRequest({
				rule: {
					name: "Preview rule",
					severity: "critical",
					enabled: true,
					serviceNames: ["checkout"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					// The create form's defaults: a 5-minute window over the last 24h.
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-02T00:00:00.000Z",
			})

			const response = yield* alerts.previewRule(orgId, adminRoles, request)

			// 288 windows — the bucket cap used to stop at 200, so the chart drew
			// only the newest 16h40m of a full-width 24h axis.
			const points = response.series[0]!.points
			assert.lengthOf(points, 288)
			assert.isNull(response.truncatedToStart)
			assert.strictEqual(points[0]?.bucket, "2026-01-01T00:00:00.000Z")
			assert.strictEqual(points[287]?.bucket, "2026-01-01T23:55:00.000Z")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("clamps to the newest windows and reports the clamp when the range is too long", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: [bucketRow("2026-01-01 00:00:00", 10)] }

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview_clamped")

			const request = decodePreviewRequest({
				rule: {
					name: "Preview rule",
					severity: "critical",
					enabled: true,
					serviceNames: ["checkout"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					// 1-minute windows over 30 days is 43,200 evaluations — far past
					// anything a preview replays.
					windowMinutes: 1,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-31T00:00:00.000Z",
			})

			const response = yield* alerts.previewRule(orgId, adminRoles, request)

			const points = response.series[0]!.points
			assert.lengthOf(points, 1500)
			// The clamped start is what the chart frames its axis on.
			assert.strictEqual(response.truncatedToStart, "2026-01-29T23:00:00.000Z")
			assert.strictEqual(points[0]?.bucket, "2026-01-29T23:00:00.000Z")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("adds a provisional point for the trailing partial window", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
				bucketRow("2026-01-01 00:00:00", 10),
				bucketRow("2026-01-01 00:05:00", 12),
				bucketRow("2026-01-01 00:30:00", 8),
			],
		}

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview_partial")

			const request = decodePreviewRequest({
				rule: {
					name: "Preview rule",
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
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				// 2.5 minutes past the last complete 5-minute boundary.
				endTime: "2026-01-01T00:32:30.000Z",
			})

			const response = yield* alerts.previewRule(orgId, adminRoles, request)

			assert.lengthOf(response.series, 1)
			const points = response.series[0]!.points
			// 6 complete windows plus the in-progress [00:30, 00:32:30) one.
			assert.lengthOf(points, 7)
			assert.isUndefined(points[5]?.provisional)
			const last = points[6]!
			assert.strictEqual(last.bucket, "2026-01-01T00:30:00.000Z")
			assert.strictEqual(last.provisional, true)
			assert.strictEqual(last.status, "breached")
			assert.strictEqual(last.value, 8)

			// The provisional window charts but must not extend the would-fire
			// simulation: the span from the two opening breaches stays the only one,
			// closed at the last complete boundary.
			assert.lengthOf(response.wouldFire, 1)
			assert.strictEqual(response.wouldFire[0]?.start, "2026-01-01T00:00:00.000Z")
			assert.strictEqual(response.wouldFire[0]?.end, "2026-01-01T00:30:00.000Z")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("previews a raw-SQL rule through the same path as every other kind", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { rawQueryRows: [{ value: 42, samples: 20 }] }

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview_raw")

			const request = decodePreviewRequest({
				rule: {
					name: "Raw preview",
					severity: "warning",
					enabled: true,
					signalType: "raw_query",
					rawQuerySql:
						"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					rawQueryReducer: "max",
					comparator: "gt",
					threshold: 10,
					windowMinutes: 5,
					minimumSampleCount: 0,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-01T00:30:00.000Z",
			})

			// Raw SQL used to be rejected here even though the UI offers the chart.
			// It is now just another evaluate source, so the preview renders.
			const preview = yield* alerts.previewRule(orgId, adminRoles, request)
			assert.isAbove(preview.series.length, 0)
			const points = preview.series[0]?.points ?? []
			assert.isAbove(points.length, 0)
			assert.isTrue(points.some((p) => p.value === 42))
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	describe("query timing", () => {
		const rawPreview = (windowMinutes: number) =>
			decodePreviewRequest({
				rule: {
					name: "Raw timing",
					severity: "warning",
					signalType: "raw_query",
					rawQuerySql:
						"SELECT count() AS value FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					comparator: "gt",
					threshold: 10,
					windowMinutes,
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-01T00:30:00.000Z",
			})

		// The timing probe reads the latest window (TestClock starts at the epoch), the chart the
		// requested 2026 range; `chart` answers the chart's query, `probe` runs before the probe's.
		const probeWarehouse = (
			probe: Effect.Effect<void, WarehouseQuotaExceededError>,
			chart: Effect.Effect<void, WarehouseQuotaExceededError> = Effect.void,
		) => {
			const stub = makeWarehouseStub({ rawQueryRows: [{ value: 1, samples: 1 }] })
			return {
				...stub,
				rawSqlQuery: (...args: Parameters<WarehouseQueryServiceApi["rawSqlQuery"]>) =>
					Effect.andThen(args[1].includes("1970-01-01") ? probe : chart, stub.rawSqlQuery(...args)),
			} satisfies WarehouseQueryServiceApi
		}

		it.effect("times one check and says which intervals the query fits", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const alerts = yield* AlertsService
				const preview = yield* alerts.previewRule(
					asOrgId("org_timing_fits"),
					adminRoles,
					rawPreview(5),
				)
				assert.deepStrictEqual(preview.queryTiming && { ...preview.queryTiming }, {
					elapsedMs: 7_800,
					failure: null,
					probeLimitMs: 25_000,
					intervalMinutes: 1,
					limitMs: 5_000,
					// 7.8 s fits 5 minutes and up; a 5-minute window allows no longer interval.
					fitsIntervalMinutes: [5],
				})
			}).pipe(
				Effect.provide(
					makeLayer(testDb, probeWarehouse(TestClock.adjust(Duration.millis(7_800))), {
						fetch: okFetch,
					}),
				),
			)
		})

		it.effect("reports a query that ran past every limit as too slow for all of them", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const alerts = yield* AlertsService
				const preview = yield* alerts.previewRule(
					asOrgId("org_timing_slow"),
					adminRoles,
					rawPreview(5),
				)
				assert.strictEqual(preview.queryTiming?.elapsedMs, null)
				assert.strictEqual(preview.queryTiming?.failure, "query_too_slow")
				assert.deepStrictEqual(preview.queryTiming?.fitsIntervalMinutes, [])
			}).pipe(
				Effect.provide(
					makeLayer(
						testDb,
						probeWarehouse(
							Effect.fail(
								new WarehouseQuotaExceededError({
									message: "Timeout exceeded",
									pipeName: "rawSqlQuery",
									setting: "max_execution_time",
								}),
							),
						),
						{ fetch: okFetch },
					),
				),
			)
		})

		it.effect("keeps the timing when the range is too heavy to chart, instead of failing", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const alerts = yield* AlertsService
				const preview = yield* alerts.previewRule(
					asOrgId("org_timing_heavy"),
					adminRoles,
					rawPreview(5),
				)
				assert.strictEqual(preview.seriesFailure, "query_too_slow")
				assert.lengthOf(preview.series, 0)
				assert.strictEqual(preview.queryTiming?.elapsedMs, 7_800)
			}).pipe(
				Effect.provide(
					makeLayer(
						testDb,
						probeWarehouse(
							TestClock.adjust(Duration.millis(7_800)),
							Effect.fail(
								new WarehouseQuotaExceededError({
									message: "Timeout exceeded",
									pipeName: "rawSqlQuery",
									setting: "max_execution_time",
								}),
							),
						),
						{ fetch: okFetch },
					),
				),
			)
		})

		it.effect("leaves timing off a builder rule, whose queries read rollups", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const alerts = yield* AlertsService
				const preview = yield* alerts.previewRule(
					asOrgId("org_timing_builder"),
					adminRoles,
					decodePreviewRequest({
						rule: {
							name: "Error rate",
							severity: "warning",
							signalType: "error_rate",
							comparator: "gt",
							threshold: 5,
							windowMinutes: 5,
							destinationIds: [],
						},
						startTime: "2026-01-01T00:00:00.000Z",
						endTime: "2026-01-01T00:30:00.000Z",
					}),
				)
				assert.isUndefined(preview.queryTiming)
			}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
		})
	})

	it.effect("charts a no-data series for a raw-SQL rule whose query matches nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { rawQueryRows: [] }

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const request = decodePreviewRequest({
				rule: {
					name: "Raw preview empty",
					severity: "warning",
					signalType: "raw_query",
					rawQuerySql:
						"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					comparator: "gt",
					threshold: 10,
					windowMinutes: 5,
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-01T00:30:00.000Z",
			})

			// The scheduler sees one no-data observation per tick here, so the preview must too.
			const preview = yield* alerts.previewRule(asOrgId("org_preview_raw_empty"), adminRoles, request)
			assert.lengthOf(preview.series, 1)
			const points = preview.series[0]?.points ?? []
			assert.lengthOf(points, 6)
			assert.isTrue(points.every((p) => p.status === "skipped" && p.skipReason === "no_data"))
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("previews a grouped raw-SQL rule that alerts on no data the way the scheduler fires", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rawQueryRows: [
				{ bucket: "2026-01-01 00:00:00", group: "a", value: 1, samples: 5 },
				{ bucket: "2026-01-01 00:05:00", group: "a", value: 1, samples: 5 },
			],
		}

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const request = decodePreviewRequest({
				rule: {
					name: "Raw grouped no data",
					severity: "warning",
					signalType: "raw_query",
					rawQuerySql:
						"SELECT $__timeGroup(Timestamp) AS bucket, ServiceName AS group, count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY bucket, group",
					comparator: "gt",
					threshold: 10,
					windowMinutes: 5,
					consecutiveBreachesRequired: 1,
					alertOnNoData: true,
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-01T00:30:00.000Z",
			})

			const preview = yield* alerts.previewRule(asOrgId("org_preview_raw_grouped"), adminRoles, request)
			const byGroup = new Map(preview.series.map((series) => [series.groupKey, series.points]))
			// A group missing from a tick is not evaluated by the scheduler, so it never breaches.
			const a = byGroup.get("a") ?? []
			assert.isTrue(a.slice(2).every((p) => p.status === "skipped" && p.skipReason === "no_data"))
			// Ticks where nothing reported at all breach under the empty-result key.
			const empty = byGroup.get("all") ?? []
			assert.deepStrictEqual(
				empty.map((p) => p.status),
				["healthy", "healthy", "breached", "breached", "breached", "breached"],
			)
			assert.isTrue(preview.wouldFire.every((span) => span.groupKey === "all"))
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("dedupes rule destinations and environments, preserving order", () => {
		const testDb = createTestDb(trackedDbs)
		// Guards the `Arr.dedupe` calls in normalizeRule. A destination listed twice
		// still notifies once, and the surviving order is first-occurrence — the
		// same contract `[...new Set()]` gave before.
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_dedupe")
			const userId = asUserId("user_dedupe")
			const first = yield* createWebhookDestination(alerts, orgId, userId)
			const second = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "webhook",
				name: "Secondary webhook",
				enabled: true,
				url: "https://example.com/maple-alerts-2",
				signingSecret: "webhook-secret-2",
			})

			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Deduped rule",
					severity: "warning",
					enabled: true,
					serviceNames: ["checkout"],
					environments: ["  prod  ", "staging", "prod", "   ", "staging"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					destinationIds: [second.id, first.id, second.id],
				}),
			)

			assert.deepStrictEqual(rule.destinationIds, [second.id, first.id])
			// Trimmed, blank-dropped, deduped, first-occurrence order.
			assert.deepStrictEqual(rule.environments, ["prod", "staging"])
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
	})

	it.effect("keeps scheduler tick round-trips flat as rule count grows", () => {
		const testDb = createTestDb(trackedDbs)
		const counter = { executes: 0 }
		// Counts `Database.execute` calls, which is the unit that costs: under
		// `DatabasePgLive` each one dials and tears down its own postgres.js client.
		// This guards the tick-head prefetch and the set-based housekeeping against
		// someone re-adding a statement inside the per-rule loop — which is exactly
		// how the tick reached ~7 dials per rule per minute in production.
		const countingDb = {
			...testDb,
			layer: Layer.effect(
				Database,
				Effect.gen(function* () {
					const inner = yield* Database
					return Database.of({
						execute: (fn) => {
							counter.executes += 1
							return inner.execute(fn)
						},
					})
				}),
			).pipe(Layer.provide(testDb.layer)),
		}

		const seedRules = (
			alerts: AlertsServiceApi,
			orgId: ReturnType<typeof asOrgId>,
			userId: ReturnType<typeof asUserId>,
			destinationId: AlertDestinationId,
			from: number,
			count: number,
		) =>
			Effect.forEach(
				Array.from({ length: count }, (_, index) => from + index),
				(index) =>
					alerts.createRule(
						orgId,
						userId,
						adminRoles,
						new AlertRuleUpsertRequest({
							name: `Scaling rule ${index}`,
							severity: "warning",
							enabled: true,
							serviceNames: ["checkout"],
							signalType: "error_rate",
							comparator: "gt",
							threshold: 5,
							windowMinutes: 5,
							destinationIds: [destinationId],
						}),
					),
				{ concurrency: 1, discard: true },
			)

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_roundtrip")
			const userId = asUserId("user_roundtrip")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			yield* seedRules(alerts, orgId, userId, destination.id, 0, 3)
			counter.executes = 0
			yield* alerts.runSchedulerTick()
			const forThree = counter.executes

			yield* seedRules(alerts, orgId, userId, destination.id, 3, 9)
			yield* TestClock.adjust(Duration.minutes(1))
			counter.executes = 0
			yield* alerts.runSchedulerTick()
			const forTwelve = counter.executes

			// Four times the rules must not cost four times the round-trips. The old
			// shape was ~7 per rule, so 3 → 12 rules would have added ~63 executes.
			const perExtraRule = (forTwelve - forThree) / 9
			assert.isBelow(
				perExtraRule,
				3,
				`expected well under 3 executes per additional rule, got ${perExtraRule} (${forThree} for 3 rules, ${forTwelve} for 12)`,
			)
		}).pipe(Effect.provide(makeLayer(countingDb, makeWarehouseStub({}), { fetch: okFetch })))
	})

	it.effect("does not auto-resolve an incident whose group is still evaluating", () => {
		const testDb = createTestDb(trackedDbs)
		// A grouped rule where both groups stay breached across two ticks. The tick
		// reads open incidents from a tick-head prefetch now, so this is the
		// regression guard for that snapshot going stale: neither group is orphaned,
		// so `resolveOrphanedGroupIncidents` must leave both incidents open rather
		// than firing an all-clear for the one it saw before this tick's writes.
		// Rows in the shape the `error_rate` timeseries actually returns. They used
		// to be `{ groupKey, value, sampleCount }` — a shape from an older
		// evaluation path that nothing decoded, so nothing noticed.
		const breachedGroups = {
			tracesAggregateRows: [
				tracesRow({ groupName: "checkout", count: 500, errorRate: 42 }),
				tracesRow({ groupName: "payments", count: 500, errorRate: 37 }),
			],
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_orphan_guard")
			const userId = asUserId("user_orphan_guard")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Grouped error rate",
					severity: "critical",
					enabled: true,
					serviceNames: ["checkout", "payments"],
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

			yield* alerts.runSchedulerTick()
			const afterFirst = yield* alerts.listIncidents(orgId)
			const openAfterFirst = afterFirst.incidents.filter((i) => i.status === "open")

			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const afterSecond = yield* alerts.listIncidents(orgId)
			const openAfterSecond = afterSecond.incidents.filter((i) => i.status === "open")
			const resolvedAfterSecond = afterSecond.incidents.filter((i) => i.status === "resolved")

			// Still breaching on the second tick, so nothing may have been resolved.
			assert.strictEqual(
				openAfterSecond.length,
				openAfterFirst.length,
				"a still-breaching group lost its open incident",
			)
			assert.lengthOf(resolvedAfterSecond, 0)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(breachedGroups), { fetch: okFetch })))
	})
})
