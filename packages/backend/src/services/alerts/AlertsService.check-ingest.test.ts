// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { WarehouseUpstreamError } from "@maple/domain/http"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, HashMap, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import type { OrgId } from "@maple/domain/http"
import type { WarehouseQueryServiceApi } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { AlertsService } from "./AlertsService"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	tracesRow,
	makeWarehouseStub,
	DEFAULT_CLOCK_EPOCH_MS,
	makeLayer,
	asOrgId,
	asUserId,
	createWebhookDestination,
	createErrorRateRule,
	insertDeliveryEventRow,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const ORG_OK = asOrgId("org_checks_ok")
const ORG_SLOW = asOrgId("org_checks_slow")
const ORG_STALLED = asOrgId("org_checks_stalled")
const ORG_520 = asOrgId("org_checks_520")

type InsertOutcome = "written" | "interrupted" | "failed"

// The real event loop runs PGlite and the webhook fetch; TestClock does not move here.
const waitUntil = (condition: Effect.Effect<boolean>) =>
	condition.pipe(
		Effect.tap((done) =>
			done ? Effect.void : Effect.promise(() => new Promise((r) => setTimeout(r, 10))),
		),
		Effect.repeat({ until: (done) => done, times: 500 }),
	)

describe("AlertsService alert_checks ingest", () => {
	it.effect(
		"drains deliveries while an insert stalls, drops it at the timeout, and joins the ingest",
		() => {
			const testDb = createTestDb(trackedDbs)
			const delivered = { count: 0 }
			const webhookFetch = (async () => {
				delivered.count += 1
				return new Response("ok", { status: 200 })
			}) as typeof fetch
			const calls = Ref.makeUnsafe(HashMap.empty<OrgId, number>())
			const outcomes = Ref.makeUnsafe(HashMap.empty<OrgId, InsertOutcome>())
			const record = (orgId: OrgId, outcome: InsertOutcome) =>
				Ref.update(outcomes, HashMap.set(orgId, outcome))
			const stub: WarehouseQueryServiceApi = {
				...makeWarehouseStub({ tracesAggregateRows: [tracesRow({ count: 100 })] }),
				ingest: (tenant, datasource) => {
					if (datasource !== "alert_checks") return Effect.void
					const orgId = tenant.orgId
					const counted = Ref.update(calls, (map) =>
						HashMap.set(map, orgId, Option.getOrElse(HashMap.get(map, orgId), () => 0) + 1),
					)
					const insert =
						orgId === ORG_STALLED
							? Effect.sleep(Duration.seconds(30))
							: orgId === ORG_SLOW
								? Effect.sleep(Duration.seconds(3))
								: orgId === ORG_520
									? Effect.fail(
											new WarehouseUpstreamError({
												message: "upstream returned 520",
												pipeName: "ingest:alert_checks",
												upstreamStatus: 520,
											}),
										)
									: Effect.void
					return counted.pipe(
						Effect.andThen(insert),
						Effect.andThen(record(orgId, "written")),
						Effect.onInterrupt(() => record(orgId, "interrupted")),
						Effect.tapError(() => record(orgId, "failed")),
					)
				},
			}

			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const userId = asUserId("user_checks")
				const rules = yield* Effect.forEach([ORG_OK, ORG_SLOW, ORG_STALLED, ORG_520], (orgId) =>
					createWebhookDestination(alerts, orgId, userId).pipe(
						Effect.flatMap((destination) =>
							createErrorRateRule(alerts, orgId, userId, destination.id).pipe(
								Effect.map((rule) => ({ rule, destination })),
							),
						),
					),
				)
				const { rule, destination } = rules[0]!
				yield* Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: "00000000-0000-4000-8000-000000000901",
						orgId: ORG_OK,
						incidentId: null,
						ruleId: rule.id,
						destinationId: destination.id,
						deliveryKey: "checks-stall-1",
						eventType: "test",
						attemptNumber: 1,
						status: "queued",
						scheduledAt: DEFAULT_CLOCK_EPOCH_MS - 1_000,
						payloadJson: JSON.stringify({
							eventType: "test",
							incidentId: null,
							incidentStatus: "resolved",
							dedupeKey: "checks-stall-1",
							observed: { value: 0, sampleCount: 0 },
						}),
					}),
				)

				const tick = yield* Effect.forkChild(alerts.runSchedulerTick())

				// The page goes out while two inserts are still pending.
				yield* waitUntil(Effect.sync(() => delivered.count === 1))
				assert.strictEqual(delivered.count, 1)
				const pending = yield* Ref.get(outcomes)
				assert.isTrue(Option.isNone(HashMap.get(pending, ORG_STALLED)))
				assert.isTrue(Option.isNone(HashMap.get(pending, ORG_SLOW)))
				assert.isUndefined(tick.pollUnsafe())

				// A slow insert that lands inside the timeout is kept and awaited.
				yield* TestClock.adjust(Duration.seconds(3))
				yield* waitUntil(Effect.map(Ref.get(outcomes), (map) => HashMap.has(map, ORG_SLOW)))
				assert.isUndefined(tick.pollUnsafe())

				// The stalled insert is cut at 5s and the tick returns with its rows dropped.
				yield* TestClock.adjust(Duration.seconds(2))
				const result = yield* Fiber.join(tick)

				const final = yield* Ref.get(outcomes)
				assert.deepStrictEqual(Option.getOrUndefined(HashMap.get(final, ORG_OK)), "written")
				assert.deepStrictEqual(Option.getOrUndefined(HashMap.get(final, ORG_SLOW)), "written")
				assert.deepStrictEqual(Option.getOrUndefined(HashMap.get(final, ORG_STALLED)), "interrupted")
				assert.deepStrictEqual(Option.getOrUndefined(HashMap.get(final, ORG_520)), "failed")
				// One POST per org: a failed insert may already be stored, so it is never retried.
				assert.deepStrictEqual(Array.from(HashMap.values(yield* Ref.get(calls))), [1, 1, 1, 1])
				// One check row per rule; the stalled org and the 520 org lose theirs.
				assert.strictEqual(result.alertChecksDroppedCount, 2)
				assert.strictEqual(result.processedCount, 1)
			}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: webhookFetch })))
		},
	)
})
