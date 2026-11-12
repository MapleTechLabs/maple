import { afterEach, assert, describe, it } from "@effect/vitest"
import { WarehouseUpstreamError } from "@maple/domain/http"
import type { AuditDetectionFilters } from "@maple/domain/audit-trail"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { Array as Arr, Duration, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { AuditDetectionsService } from "@maple/backend/services/audit-trail/AuditDetectionsService"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	alertServices,
	asOrgId,
	asUserId,
	createWebhookDestination,
	makeLayer,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

/** Fetch bodies arrive as a string or, from the Effect HTTP client, as bytes. */
const requestBodyText = (body: RequestInit["body"]): string =>
	body instanceof Uint8Array ? new TextDecoder().decode(body) : typeof body === "string" ? body : ""

/** What the audit trail answers a detection's count with; mutated as a test moves on. */
interface Trail {
	matchingEvents: number
	down?: boolean
}

/**
 * A warehouse answering the detection count and keeping the SQL of each count it was asked
 * for, and a webhook endpoint keeping the bodies it was sent.
 */
const harness = (trail: Trail) => {
	const testDb = createTestDb(trackedDbs)
	const counted: Array<string> = []
	const bodies: Array<string> = []
	const fetchImpl: typeof fetch = async (_input, init) => {
		bodies.push(requestBodyText(init?.body))
		return new Response("ok", { status: 200 })
	}
	const warehouse = makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled, options) =>
			Effect.gen(function* () {
				const query = compiledQueryOf(compiled)
				if (options?.context !== "auditTrailCount") {
					return yield* query.decodeRows([]).pipe(Effect.orDie)
				}
				if (trail.down === true) {
					return yield* new WarehouseUpstreamError({
						message: "warehouse down",
						pipeName: "auditTrailCount",
					})
				}
				counted.push(query.sql)
				return yield* query.decodeRows([{ events: trail.matchingEvents }]).pipe(Effect.orDie)
			}),
	})
	const detections = Layer.effect(AuditDetectionsService, AuditDetectionsService.make).pipe(
		Layer.provide(testDb.layer),
	)
	return {
		testDb,
		counted,
		bodies,
		layer: Layer.mergeAll(makeLayer(testDb, warehouse, { fetch: fetchImpl }), detections),
	}
}

const orgId = asOrgId("org_audit_alerts")
const userId = asUserId("user_audit_alerts")

const createDetection = Effect.fn(function* (filters: AuditDetectionFilters = { category: "membership" }) {
	const alerts = yield* alertServices
	const detections = yield* AuditDetectionsService
	const destination = yield* createWebhookDestination(alerts, orgId, userId)
	return yield* detections.create(orgId, {
		name: "Members added",
		filters,
		windowMinutes: 10,
		threshold: 3,
		severity: "critical",
		destinationIds: [destination.id],
		createdBy: userId,
	})
})

const ruleState = (testDb: TestDb, ruleId: string) =>
	Effect.promise(() =>
		queryFirstRow<{ last_status: string | null; last_value: number | null; last_error: string | null }>(
			testDb,
			"select last_status, last_value, last_error from alert_rule_states where rule_id = $1",
			[ruleId],
		),
	)

describe("AlertsService audit log detections", () => {
	it.effect("stays healthy below the count and opens nothing", () => {
		const { layer, testDb } = harness({ matchingEvents: 2 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const detection = yield* createDetection()

			yield* alerts.runSchedulerTick()

			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
			assert.deepInclude(yield* ruleState(testDb, detection.id), {
				last_status: "healthy",
				last_value: 2,
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("opens an incident at the count, notifies the destination, and resolves below it", () => {
		const trail: Trail = { matchingEvents: 3 }
		const { layer } = harness(trail)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const detection = yield* createDetection()

			yield* alerts.runSchedulerTick()
			const opened = (yield* alerts.listIncidents(orgId)).incidents
			assert.lengthOf(opened, 1)
			assert.deepInclude(opened[0], {
				ruleId: detection.id,
				ruleName: "Members added",
				signalType: "audit",
				severity: "critical",
				status: "open",
				lastObservedValue: 3,
			})
			assert.deepStrictEqual(
				Arr.map((yield* alerts.listDeliveryEvents(orgId)).events, (event) => event.eventType),
				["trigger"],
			)

			// The events slide out of the window: the count is a real zero, so it resolves.
			trail.matchingEvents = 0
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "resolved")
		}).pipe(Effect.provide(layer))
	})

	// Notifications say how many events matched and over which window, never which events.
	it.effect("notifies with the count as its detail", () => {
		const { layer, bodies } = harness({ matchingEvents: 4 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			yield* createDetection()
			yield* alerts.runSchedulerTick()

			const trigger = Schema.decodeSync(
				Schema.fromJsonString(
					Schema.Struct({
						eventType: Schema.String,
						observed: Schema.Struct({ detail: Schema.String, value: Schema.Number }),
					}),
				),
			)(bodies[0] ?? "")
			assert.deepStrictEqual(trigger, {
				eventType: "trigger",
				observed: { detail: "4 matching audit events in the last 10 minutes", value: 4 },
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("counts the detection's filters over its window, ending at the snapped minute", () => {
		const { layer, counted } = harness({ matchingEvents: 0 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			yield* createDetection({ provider: "vercel", action: "team.member.added" })

			yield* alerts.runSchedulerTick()

			// 1_700_000_000_000 is 22:13:20 UTC: the window ends at 22:13 and reaches back 10 minutes.
			assert.lengthOf(counted, 1)
			assert.include(counted[0], `OrgId = '${orgId}'`)
			assert.include(counted[0], "IngestedAt > '2023-11-14 22:03:00'")
			assert.include(counted[0], "IngestedAt <= '2023-11-14 22:13:00'")
			assert.include(counted[0], "Provider = 'vercel'")
			assert.include(counted[0], "Action = 'team.member.added'")
		}).pipe(Effect.provide(layer))
	})

	it.effect("a stored audit rule with no filters column counts every event", () => {
		const { layer, counted, testDb } = harness({ matchingEvents: 3 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const detection = yield* createDetection()
			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set audit_filters_json = null where id = $1", [
					detection.id,
				]),
			)

			yield* alerts.runSchedulerTick()

			assert.notInclude(counted[0], "Category =")
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 1)
		}).pipe(Effect.provide(layer))
	})

	// A count that could not be read is not a count of zero: the incident must not resolve on it.
	it.effect("keeps an open incident open and records the failure while the audit trail is down", () => {
		const trail: Trail = { matchingEvents: 3 }
		const { layer, testDb } = harness(trail)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const detection = yield* createDetection()
			yield* alerts.runSchedulerTick()

			trail.down = true
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "open")
			assert.isNotNull((yield* ruleState(testDb, detection.id))?.last_error)
		}).pipe(Effect.provide(layer))
	})

	it.effect("a disabled detection is not checked", () => {
		const { layer, counted } = harness({ matchingEvents: 3 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const detections = yield* AuditDetectionsService
			const detection = yield* createDetection()
			yield* detections.update(orgId, detection.id, { enabled: false, updatedBy: userId })

			yield* alerts.runSchedulerTick()

			assert.lengthOf(counted, 0)
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
		}).pipe(Effect.provide(layer))
	})
})
