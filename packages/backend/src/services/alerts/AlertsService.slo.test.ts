import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	Clock,
	Duration,
	Effect,
	Layer,
	Option,
	Order,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
import { TestClock } from "effect/testing"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { AlertDestinationId } from "@maple/primitives"
import { WebhookAlertDestinationConfig } from "@maple/domain/http"
import { type AlertsServiceApi } from "./AlertsService"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
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
	alertServices,
} from "./alerts-service-test-support"
import { SloReadService } from "@maple/backend/services/slos/SloReadService"
import { SLO_BUDGET_GROUP_KEY } from "@maple/domain/slo"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

/** The traffic every warehouse read sees, uniform over the past; mutated as a test moves on. */
interface Traffic {
	badPerMille: number
	/** Events a minute; 1000 unless a test is about a quiet service. */
	perMinute?: number
	/** No spans at all: the service is down or ingest stalled. */
	silent?: boolean
	/** No spans in only the newest minutes; older minutes keep their traffic. */
	silentMinutes?: number
	/** Only the newest minutes carry the bad share; every minute does when unset. */
	badMinutes?: number
	/** The SLO window's events, when a test sets the budget apart from the burn. */
	window?: { total: number; good: number }
}

const SERVICES = ["checkout", "cart", "search"]
const BURN_WINDOWS = [5, 30, 60, 120, 360, 1440] as const

/** The events of the `minutes` before the tick. */
const eventsIn = (traffic: Traffic, minutes: number) => {
	const live = traffic.silent === true ? 0 : Math.max(0, minutes - (traffic.silentMinutes ?? 0))
	const perMinute = traffic.perMinute ?? 1000
	const silent = minutes - live
	const badLive = Math.max(0, Math.min(minutes, traffic.badMinutes ?? minutes) - silent)
	const total = live * perMinute
	return { total, good: total - (badLive * perMinute * traffic.badPerMille) / 1000 }
}

/** The two `'YYYY-MM-DD hh:mm:ss'` bounds of a compiled liveness probe, as a length in minutes. */
const probeMinutes = (sql: string, nowMs: number) => {
	const bounds = Arr.map(
		Option.getOrElse(Str.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g)(sql), () => []),
		(text) => Date.parse(`${Str.replace(" ", "T")(text)}Z`),
	)
	const startMs = Math.min(...bounds)
	const endMs = Math.max(...bounds)
	return { minutes: Math.round((endMs - startMs) / 60_000), isPast: endMs < nowMs - 3_600_000 }
}

/**
 * A warehouse answering the SLO alert reads and the liveness probe from one uniform traffic
 * model, so every burn window sees the same bad share. `reads` counts queries by context.
 */
const sloWarehouse = (traffic: Traffic, reads: Array<string> = []) =>
	makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled, options) =>
			Effect.gen(function* () {
				reads.push(options?.context ?? "")
				const burnRow = (serviceName: string) => ({
					serviceName,
					environment: "production",
					...Rec.fromEntries(
						Arr.flatMap(BURN_WINDOWS, (minutes): ReadonlyArray<readonly [string, number]> => {
							const events = eventsIn(traffic, minutes)
							return [
								[`total${minutes}`, events.total],
								[`good${minutes}`, events.good],
							]
						}),
					),
				})
				// A full budget unless a test sets it: the burn tests are about the burn.
				const window = traffic.window ?? { total: 1_000_000, good: 1_000_000 }
				const rows =
					options?.context === "sloStatusBurn"
						? Arr.map(SERVICES, burnRow)
						: options?.context === "sloStatusTotals"
							? Arr.map(SERVICES, (serviceName) => ({
									serviceName,
									environment: "production",
									...window,
								}))
							: []
				return yield* compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)
			}),
		// The liveness probe: how much the service sent in a window now, and a day ago.
		compiledQueryFirst: (_tenant, compiled, options) =>
			Effect.gen(function* () {
				reads.push(options?.context ?? "")
				const nowMs = yield* Clock.currentTimeMillis
				const query = compiledQueryOf(compiled)
				const probe = probeMinutes(query.sql, nowMs)
				// Yesterday the service was up, whatever it does now.
				const spanCount = probe.isPast
					? probe.minutes * (traffic.perMinute ?? 1000)
					: eventsIn(traffic, probe.minutes).total
				return yield* query
					.decodeFirstRow([
						{
							minutesWithData: spanCount > 0 ? probe.minutes : 0,
							spanCount,
							estimatedSpanCount: spanCount,
							errorCount: 0,
							estimatedErrorCount: 0,
							lastSeen: "2023-11-14 22:13:00",
						},
					])
					.pipe(Effect.orDie)
			}),
	})

const harness = (traffic: Traffic, reads: Array<string> = []) => {
	const testDb = createTestDb(trackedDbs)
	const warehouse = sloWarehouse(traffic, reads)
	const slos = Layer.effect(SlosService, SlosService.make).pipe(
		Layer.provide(Layer.effect(SloReadService, SloReadService.make)),
		Layer.provide(Layer.mergeAll(testDb.layer, Layer.succeed(WarehouseQueryService, warehouse))),
	)
	return { testDb, layer: Layer.mergeAll(makeLayer(testDb, warehouse), slos) }
}

const orgId = asOrgId("org_slo_alerts")
const userId = asUserId("user_slo_alerts")

const createSlo = Effect.fn(function* (destinationId: AlertDestinationId | undefined, targetPercent = 99.9) {
	const slos = yield* SlosService
	return yield* slos.create(orgId, {
		name: "Checkout availability",
		serviceName: "checkout",
		environments: ["production"],
		sli: { _tag: "availability" },
		targetPercent,
		alerting:
			destinationId === undefined
				? {}
				: { criticalDestinationIds: [destinationId], warningDestinationIds: [destinationId] },
		createdBy: userId,
	})
})

/** A webhook destination of its own, so a test can tell which tier notified whom. */
const createNamedWebhook = (alerts: AlertsServiceApi, name: string) =>
	alerts.createDestination(
		orgId,
		userId,
		adminRoles,
		new WebhookAlertDestinationConfig({
			type: "webhook",
			name,
			enabled: true,
			url: `https://example.com/${name}`,
			signingSecret: "webhook-secret",
		}),
	)

/** Opens an incident at `badPerMille` and returns which destinations it notified. */
const notifiedBy = (badPerMille: number) => {
	const { layer } = harness({ badPerMille })
	return Effect.gen(function* () {
		yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
		const alerts = yield* alertServices
		const pager = yield* createNamedWebhook(alerts, "pager")
		const tickets = yield* createNamedWebhook(alerts, "tickets")
		const slos = yield* SlosService
		yield* slos.create(orgId, {
			name: "Checkout availability",
			serviceName: "checkout",
			environments: ["production"],
			sli: { _tag: "availability" },
			targetPercent: 99.9,
			alerting: { criticalDestinationIds: [pager.id], warningDestinationIds: [tickets.id] },
			createdBy: userId,
		})
		yield* alerts.runSchedulerTick()
		const events = (yield* alerts.listDeliveryEvents(orgId)).events
		return Arr.sort(Arr.dedupe(Arr.map(events, (event) => event.destinationName)), Order.String)
	}).pipe(Effect.provide(layer))
}

describe("AlertsService SLO burn-rate rules", () => {
	it.effect("a slow burn tickets only the warning destination", () =>
		Effect.map(notifiedBy(8), (notified) => assert.deepStrictEqual(notified, ["tickets"])),
	)

	it.effect("a fast burn pages the critical destination, and the warning one too", () =>
		Effect.map(notifiedBy(20), (notified) => assert.deepStrictEqual(notified, ["pager", "tickets"])),
	)

	it.effect("a fast burn pages, and a recovered short window resolves it", () => {
		const traffic: Traffic = { badPerMille: 20 }
		const { layer } = harness(traffic)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
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
			const alerts = yield* alertServices
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

	it.effect("a page stays open while its 5m window is empty, even once the warning tier clears", () => {
		const traffic: Traffic = { badPerMille: 20 }
		const { layer } = harness(traffic)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			yield* createSlo(undefined)
			yield* alerts.runSchedulerTick()
			assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.severity, "critical")

			// The newest minutes go quiet and the older ones turn healthy: warning clears, critical holds.
			traffic.badPerMille = 0
			traffic.silentMinutes = 6
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const held = (yield* alerts.listIncidents(orgId)).incidents
			assert.strictEqual(held[0]?.status, "open")
			assert.strictEqual(held[0]?.severity, "critical")
		}).pipe(Effect.provide(layer))
	})

	it.effect("a page stays open hours after the service went dark, when every short window is empty", () => {
		const traffic: Traffic = { badPerMille: 20 }
		const { layer } = harness(traffic)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			yield* createSlo(undefined)
			yield* alerts.runSchedulerTick()
			assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "open")

			// Dead for 130 minutes: nothing in the 5m, 30m or 2h windows, though most of the
			// last day still holds traffic. That is an outage, not a recovery.
			traffic.silentMinutes = 130
			yield* TestClock.adjust(Duration.minutes(130))
			yield* alerts.runSchedulerTick()
			const held = (yield* alerts.listIncidents(orgId)).incidents
			assert.strictEqual(held[0]?.status, "open")
			assert.strictEqual(held[0]?.holdReason, "no_data")
		}).pipe(Effect.provide(layer))
	})

	it.effect("one failed request on a quiet service opens nothing", () => {
		// Twelve requests an hour and one of the last hour's failed: an 83x burn on one request.
		const { layer } = harness({ badPerMille: 1000 / 12, perMinute: 0.2, badMinutes: 60 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			yield* createSlo(undefined)
			yield* alerts.runSchedulerTick()
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("a total outage pages at a 90% target, whose burn tops out at 10x", () => {
		const { layer } = harness({ badPerMille: 1000 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			yield* createSlo(undefined, 90)
			yield* alerts.runSchedulerTick()
			const opened = (yield* alerts.listIncidents(orgId)).incidents
			assert.strictEqual(opened[0]?.severity, "critical")
			// The incident's threshold is the burn this target pages at, not the 14.4x it cannot reach.
			assert.closeTo(opened[0]?.threshold ?? 0, 8, 1e-9)
		}).pipe(Effect.provide(layer))
	})

	it.effect("a 4x burn that lasts a day opens a warning", () => {
		// Under the 6x ticket factor and far under the page factor: only the slow tier sees it.
		const { layer } = harness({ badPerMille: 4 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			yield* createSlo(undefined)
			yield* alerts.runSchedulerTick()
			const opened = (yield* alerts.listIncidents(orgId)).incidents
			assert.lengthOf(opened, 1)
			assert.strictEqual(opened[0]?.severity, "warning")
		}).pipe(Effect.provide(layer))
	})

	it.effect("a spent error budget is a warning of its own, and clears when the budget is back", () => {
		// Burning at half the sustainable rate now, but the window as a whole is at twice its budget.
		const traffic: Traffic = { badPerMille: 0.5, window: { total: 1_000_000, good: 998_000 } }
		const { layer } = harness(traffic)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			yield* createSlo(undefined)
			yield* alerts.runSchedulerTick()
			const opened = (yield* alerts.listIncidents(orgId)).incidents
			assert.lengthOf(opened, 1)
			assert.strictEqual(opened[0]?.severity, "warning")
			assert.strictEqual(opened[0]?.groupKey, SLO_BUDGET_GROUP_KEY)

			// The budget is read every few minutes, not every check.
			traffic.window = { total: 1_000_000, good: 999_500 }
			yield* TestClock.adjust(Duration.minutes(6))
			yield* alerts.runSchedulerTick()
			assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "resolved")
		}).pipe(Effect.provide(layer))
	})

	it.effect("a burn page resolves when the burn stops, though the budget it spent stays a warning", () => {
		const traffic: Traffic = { badPerMille: 20, window: { total: 1_000_000, good: 990_000 } }
		const { layer } = harness(traffic)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			yield* createSlo(undefined)
			yield* alerts.runSchedulerTick()
			traffic.badPerMille = 0
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const incidents = (yield* alerts.listIncidents(orgId)).incidents
			const statusOf = (groupKey: string) =>
				Arr.findFirst(incidents, (incident) => incident.groupKey === groupKey).pipe(
					Option.map((incident) => `${incident.severity} ${incident.status}`),
					Option.getOrNull,
				)
			assert.strictEqual(statusOf("__total__"), "critical resolved")
			assert.strictEqual(statusOf(SLO_BUDGET_GROUP_KEY), "warning open")
		}).pipe(Effect.provide(layer))
	})

	it.effect("checks every SLO of an org from one burn read a tick", () => {
		const reads: Array<string> = []
		const { layer } = harness({ badPerMille: 0 }, reads)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const slos = yield* SlosService
			yield* Effect.forEach(
				SERVICES,
				(serviceName) =>
					slos.create(orgId, {
						name: `${serviceName} availability`,
						serviceName,
						environments: ["production"],
						sli: { _tag: "availability" },
						targetPercent: 99.9,
						createdBy: userId,
					}),
				{ discard: true },
			)
			reads.length = 0
			yield* alerts.runSchedulerTick()
			assert.lengthOf(
				Arr.filter(reads, (context) => context === "sloStatusBurn"),
				1,
			)
			assert.lengthOf(
				Arr.filter(reads, (context) => context === "sloBurnWindows"),
				0,
			)
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
			const alerts = yield* alertServices
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
			const alerts = yield* alertServices
			yield* createSlo(undefined)
			yield* alerts.runSchedulerTick()
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("the rule is hidden from the rule APIs and deleted with its SLO", () => {
		const { layer, testDb } = harness({ badPerMille: 0 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
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
