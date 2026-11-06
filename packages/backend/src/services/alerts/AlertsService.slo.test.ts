import { afterEach, assert, describe, it } from "@effect/vitest"
import { Clock, Duration, Effect, Layer, Option, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { AlertDestinationId } from "@maple/domain/primitives"
import { AlertsService } from "./AlertsService"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { MAX_SLOS_PER_ORG, SlosService } from "@maple/backend/services/slos/SlosService"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminRoles,
	asOrgId,
	asUserId,
	createWebhookDestination,
	makeLayer,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

/** Bad events per 1000 in every minute the burn read sees; mutated as a test moves on. */
interface Traffic {
	badPerMille: number
	/** No spans at all: the service is down or ingest stalled. */
	silent?: boolean
}

/**
 * A warehouse answering the SLO burn read with 400 minutes of uniform traffic ending at the
 * test clock, so every burn window sees the same bad share.
 */
const sloWarehouse = (traffic: Traffic) =>
	makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled, options) =>
			Effect.gen(function* () {
				const nowMs = yield* Clock.currentTimeMillis
				const minute = Math.floor(nowMs / 60_000) * 60_000
				const rows =
					options?.context === "sloBurnWindows" && traffic.silent !== true
						? Arr.makeBy(400, (index) => ({
								bucket: formatWarehouseDateTime(minute - index * 60_000),
								total: 1000,
								good: 1000 - traffic.badPerMille,
							}))
						: []
				return yield* compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)
			}),
	})

const harness = (traffic: Traffic) => {
	const testDb = createTestDb(trackedDbs)
	const warehouse = sloWarehouse(traffic)
	const slos = Layer.effect(SlosService, SlosService.make).pipe(
		Layer.provide(Layer.mergeAll(testDb.layer, Layer.succeed(WarehouseQueryService, warehouse))),
	)
	return { testDb, layer: Layer.mergeAll(makeLayer(testDb, warehouse), slos) }
}

const orgId = asOrgId("org_slo_alerts")
const userId = asUserId("user_slo_alerts")

const createSlo = Effect.fn(function* (destinationId: AlertDestinationId | undefined) {
	const slos = yield* SlosService
	return yield* slos.create(orgId, {
		name: "Checkout availability",
		serviceName: "checkout",
		environments: ["production"],
		sli: { _tag: "availability" },
		targetPercent: 99.9,
		alerting:
			destinationId === undefined
				? {}
				: { criticalDestinationIds: [destinationId], warningDestinationIds: [destinationId] },
		createdBy: userId,
	})
})

describe("AlertsService SLO burn-rate rules", () => {
	it.effect("a fast burn pages, and a recovered short window resolves it", () => {
		const traffic: Traffic = { badPerMille: 20 }
		const { layer } = harness(traffic)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const slo = yield* createSlo(destination.id)
			assert.isNotNull(slo.alertRuleId)

			// 2% bad at 99.9% burns 20x in every window: past both tiers, so critical.
			yield* alerts.runSchedulerTick()
			const opened = (yield* alerts.listIncidents(orgId)).incidents
			assert.lengthOf(opened, 1)
			assert.strictEqual(opened[0]?.signalType, "slo_burn_rate")
			assert.strictEqual(opened[0]?.severity, "critical")
			assert.strictEqual(opened[0]?.ruleId, slo.alertRuleId)
			assert.strictEqual(opened[0]?.ruleName, "SLO burn: Checkout availability")

			traffic.badPerMille = 0
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const resolved = (yield* alerts.listIncidents(orgId)).incidents
			assert.strictEqual(resolved[0]?.status, "resolved")
		}).pipe(Effect.provide(layer))
	})

	it.effect("a page stays open while the service sends no spans at all", () => {
		const traffic: Traffic = { badPerMille: 20 }
		const { layer } = harness(traffic)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createSlo(undefined)
			yield* alerts.runSchedulerTick()
			assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "open")

			// An outage zeroes every window: that is no data, not a recovery.
			traffic.silent = true
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const held = (yield* alerts.listIncidents(orgId)).incidents
			assert.strictEqual(held[0]?.status, "open")
			assert.strictEqual(held[0]?.severity, "critical")
		}).pipe(Effect.provide(layer))
	})

	it.effect("an edit brings back a rule whose row is gone", () => {
		const { layer, testDb } = harness({ badPerMille: 0 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const slos = yield* SlosService
			const slo = yield* createSlo(undefined)
			yield* Effect.promise(() =>
				executeSql(testDb, "delete from alert_rules where id = $1", [slo.alertRuleId]),
			)
			const updated = yield* slos.update(orgId, slo.id, { targetPercent: 99.5, updatedBy: userId })
			assert.strictEqual(updated.alertRuleId, slo.alertRuleId)
			assert.isTrue(updated.alerting.enabled)
		}).pipe(Effect.provide(layer))
	})

	it.effect("a slow burn opens a warning, not a page", () => {
		// 0.8% bad burns 8x: over the 6x ticket factor, under the 14.4x page factor.
		const { layer } = harness({ badPerMille: 8 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createSlo(undefined)
			yield* alerts.runSchedulerTick()
			const opened = (yield* alerts.listIncidents(orgId)).incidents
			assert.lengthOf(opened, 1)
			assert.strictEqual(opened[0]?.severity, "warning")
		}).pipe(Effect.provide(layer))
	})

	it.effect("a burn within budget opens nothing", () => {
		const { layer } = harness({ badPerMille: 1 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createSlo(undefined)
			yield* alerts.runSchedulerTick()
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("the rule is hidden from the rule APIs and deleted with its SLO", () => {
		const { layer, testDb } = harness({ badPerMille: 0 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const slos = yield* SlosService
			const slo = yield* createSlo(undefined)
			const ruleId = Option.getOrThrow(Option.fromNullOr(slo.alertRuleId))

			assert.lengthOf((yield* alerts.listRules(orgId)).rules, 0)
			const refused = yield* alerts.deleteRule(orgId, adminRoles, ruleId).pipe(Effect.flip)
			assert.strictEqual(refused._tag, "@maple/http/errors/AlertRuleNotFoundError")

			// Switching alerting off disables the rule; the SLO keeps it.
			const paused = yield* slos.update(orgId, slo.id, {
				alerting: { enabled: false },
				updatedBy: userId,
			})
			assert.isFalse(paused.alerting.enabled)

			yield* slos.delete(orgId, slo.id)
			const remaining = yield* Effect.promise(() =>
				queryFirstRow<{ count: number }>(
					testDb,
					"select count(*)::int as count from alert_rules where id = $1",
					[ruleId],
				),
			)
			assert.strictEqual(remaining?.count, 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("caps an org at MAX_SLOS_PER_ORG SLOs", () => {
		const { layer } = harness({ badPerMille: 0 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const slos = yield* SlosService
			const create = (index: number) =>
				slos.create(orgId, {
					name: `SLO ${index}`,
					serviceName: "checkout",
					sli: { _tag: "availability" },
					targetPercent: 99,
					createdBy: userId,
				})
			yield* Effect.forEach(Arr.range(1, MAX_SLOS_PER_ORG), create, { discard: true })
			const refused = yield* create(MAX_SLOS_PER_ORG + 1).pipe(Effect.flip)
			assert.strictEqual(refused._tag, "@maple/http/errors/SloValidationError")
			assert.lengthOf(yield* slos.list(orgId), MAX_SLOS_PER_ORG)
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses an unknown destination and keeps the SLO unsaved", () => {
		const { layer } = harness({ badPerMille: 0 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const slos = yield* SlosService
			const refused = yield* createSlo(
				AlertDestinationId.make("00000000-0000-4000-8000-000000000000"),
			).pipe(Effect.flip)
			assert.strictEqual(refused._tag, "@maple/http/errors/SloValidationError")
			assert.lengthOf(yield* slos.list(orgId), 0)
		}).pipe(Effect.provide(layer))
	})
})
