import { afterEach, assert, describe, it } from "@effect/vitest"
import { AlertRuleUpsertRequest, MAX_AUDIT_DETECTIONS_PER_ORG } from "@maple/domain/http"
import { AlertDestinationId, AlertRuleId } from "@maple/primitives"
import { Array as Arr, Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminRoles,
	alertServices,
	asOrgId,
	asUserId,
	createErrorRateRule,
	createWebhookDestination,
	makeLayer,
} from "@maple/backend/services/alerts/alerts-service-test-support"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { AuditDetectionsService, type CreateAuditDetectionInput } from "./AuditDetectionsService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = asOrgId("org_audit_detections")
const otherOrgId = asOrgId("org_audit_detections_other")
const userId = asUserId("user_audit_detections")
const editorId = asUserId("user_audit_detections_editor")

/** `matchingEvents` is what the audit trail counts for every detection's window. */
const harness = (matchingEvents = 0) => {
	const testDb = createTestDb(trackedDbs)
	const warehouse = makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled, options) =>
			compiledQueryOf(compiled)
				.decodeRows(options?.context === "auditTrailCount" ? [{ events: matchingEvents }] : [])
				.pipe(Effect.orDie),
	})
	const detections = Layer.effect(AuditDetectionsService, AuditDetectionsService.make).pipe(
		Layer.provide(testDb.layer),
	)
	return { testDb, layer: Layer.mergeAll(makeLayer(testDb, warehouse), detections) }
}

const detectionInput = (overrides: Partial<CreateAuditDetectionInput> = {}): CreateAuditDetectionInput => ({
	name: "Members added",
	filters: { provider: "vercel", category: "membership" },
	windowMinutes: 10,
	threshold: 3,
	severity: "warning",
	createdBy: userId,
	...overrides,
})

/** The tag an attempt was refused with. */
const refusal = <A, E extends { readonly _tag: string }>(attempt: Effect.Effect<A, E>) =>
	Effect.map(Effect.flip(attempt), (error) => error._tag)

const ruleRow = (testDb: TestDb, id: AlertRuleId) =>
	Effect.promise(() =>
		queryFirstRow<{
			signal_type: string
			created_by: string
			updated_by: string
			updated_at: Date
			audit_filters_json: unknown
		}>(
			testDb,
			"select signal_type, created_by, updated_by, updated_at, audit_filters_json from alert_rules where id = $1",
			[id],
		),
	)

describe("AuditDetectionsService", () => {
	it.effect("creates a detection as an audit rule owned by its author, and lists it", () => {
		const { layer, testDb } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const detections = yield* AuditDetectionsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			const created = yield* detections.create(
				orgId,
				detectionInput({ destinationIds: [destination.id, destination.id] }),
			)

			assert.deepStrictEqual(
				{ ...created, id: null },
				{
					id: null,
					name: "Members added",
					enabled: true,
					filters: { provider: "vercel", category: "membership" },
					windowMinutes: 10,
					threshold: 3,
					severity: "warning",
					destinationIds: [destination.id],
					createdAt: DEFAULT_CLOCK_EPOCH_MS,
					updatedAt: DEFAULT_CLOCK_EPOCH_MS,
				},
			)
			assert.deepStrictEqual(yield* detections.list(orgId), [created])
			assert.deepStrictEqual(yield* detections.get(orgId, created.id), created)
			const row = yield* ruleRow(testDb, created.id)
			assert.strictEqual(row?.signal_type, "audit")
			assert.strictEqual(row?.created_by, userId)
		}).pipe(Effect.provide(layer))
	})

	it.effect("lists newest first, only the org's own, and never another kind of rule", () => {
		const { layer } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const detections = yield* AuditDetectionsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			const first = yield* detections.create(orgId, detectionInput({ name: "First" }))
			yield* TestClock.adjust(Duration.minutes(1))
			const second = yield* detections.create(orgId, detectionInput({ name: "Second" }))
			yield* detections.create(otherOrgId, detectionInput({ name: "Theirs" }))

			assert.deepStrictEqual(
				Arr.map(yield* detections.list(orgId), (detection) => detection.id),
				[second.id, first.id],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("a detection with no filters counts every event", () => {
		const { layer } = harness()
		return Effect.gen(function* () {
			const detections = yield* AuditDetectionsService
			const created = yield* detections.create(orgId, {
				name: "Any event",
				windowMinutes: 5,
				threshold: 100,
				severity: "critical",
				createdBy: userId,
			})

			assert.deepStrictEqual(created.filters, {})
		}).pipe(Effect.provide(layer))
	})

	it.effect("updates only the fields sent, replacing the filters whole, under the editor's name", () => {
		const { layer, testDb } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const detections = yield* AuditDetectionsService
			const created = yield* detections.create(orgId, detectionInput())
			yield* TestClock.adjust(Duration.minutes(5))

			const updated = yield* detections.update(orgId, created.id, {
				threshold: 5,
				filters: { outcome: "denied" },
				enabled: false,
				updatedBy: editorId,
			})

			assert.deepStrictEqual(updated, {
				...created,
				threshold: 5,
				filters: { outcome: "denied" },
				enabled: false,
				updatedAt: DEFAULT_CLOCK_EPOCH_MS + 5 * 60_000,
			})
			const row = yield* ruleRow(testDb, created.id)
			assert.strictEqual(row?.created_by, userId)
			assert.strictEqual(row?.updated_by, editorId)
			assert.deepStrictEqual(row?.audit_filters_json, { outcome: "denied" })
		}).pipe(Effect.provide(layer))
	})

	// alert_rules is synced to every member's browser: a save that changes nothing writes nothing.
	it.effect("leaves the row untouched when an update changes nothing", () => {
		const { layer, testDb } = harness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const detections = yield* AuditDetectionsService
			const created = yield* detections.create(orgId, detectionInput())
			yield* TestClock.adjust(Duration.minutes(5))

			const updated = yield* detections.update(orgId, created.id, {
				name: created.name,
				threshold: created.threshold,
				updatedBy: editorId,
			})

			assert.deepStrictEqual(updated, created)
			assert.strictEqual((yield* ruleRow(testDb, created.id))?.updated_by, userId)
		}).pipe(Effect.provide(layer))
	})

	// The floor is what stops a detection firing on events from before it counted them. It has
	// to move when the detection counts more, and only then.
	it.effect("starts counting at its creation, and again when it counts more than it did", () => {
		const { layer, testDb } = harness()
		const countFrom = (id: AlertRuleId) =>
			Effect.promise(() =>
				queryFirstRow<{ floor_ms: number }>(
					testDb,
					"select (extract(epoch from audit_count_from) * 1000)::float8 as floor_ms from alert_rules where id = $1",
					[id],
				),
			).pipe(Effect.map((row) => row?.floor_ms))
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const detections = yield* AuditDetectionsService
			const created = yield* detections.create(orgId, detectionInput())
			assert.strictEqual(yield* countFrom(created.id), DEFAULT_CLOCK_EPOCH_MS)
			const edit = (change: Omit<Parameters<typeof detections.update>[2], "updatedBy">) =>
				Effect.gen(function* () {
					yield* TestClock.adjust(Duration.minutes(1))
					yield* detections.update(orgId, created.id, { ...change, updatedBy: editorId })
					const floor = yield* countFrom(created.id)
					return floor === undefined ? undefined : (floor - DEFAULT_CLOCK_EPOCH_MS) / 60_000
				})

			// Minutes after creation the floor sits at, after each edit one minute apart.
			assert.strictEqual(yield* edit({ name: "Renamed", severity: "critical", threshold: 1 }), 0)
			assert.strictEqual(yield* edit({ windowMinutes: 5 }), 0)
			assert.strictEqual(yield* edit({ windowMinutes: 30 }), 3)
			assert.strictEqual(yield* edit({ filters: { category: "credential" } }), 4)
			assert.strictEqual(yield* edit({ enabled: false }), 4)
			assert.strictEqual(yield* edit({ enabled: true }), 6)
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses an unknown destination and saves nothing", () => {
		const { layer } = harness()
		return Effect.gen(function* () {
			const detections = yield* AuditDetectionsService
			const unknown = AlertDestinationId.make("00000000-0000-4000-8000-000000000000")

			const refused = yield* detections
				.create(orgId, detectionInput({ destinationIds: [unknown] }))
				.pipe(Effect.flip)
			assert.strictEqual(refused._tag, "@maple/http/errors/AuditDetectionInvalidError")
			assert.lengthOf(yield* detections.list(orgId), 0)

			const created = yield* detections.create(orgId, detectionInput())
			const refusedEdit = yield* detections
				.update(orgId, created.id, { destinationIds: [unknown], updatedBy: userId })
				.pipe(Effect.flip)
			assert.strictEqual(refusedEdit._tag, "@maple/http/errors/AuditDetectionInvalidError")
			assert.deepStrictEqual(yield* detections.get(orgId, created.id), created)
		}).pipe(Effect.provide(layer))
	})

	// Another org's destination must read as unknown, not as usable.
	it.effect("refuses a destination that belongs to another org", () => {
		const { layer } = harness()
		return Effect.gen(function* () {
			const alerts = yield* alertServices
			const detections = yield* AuditDetectionsService
			const theirs = yield* createWebhookDestination(alerts, otherOrgId, userId)

			const refused = yield* detections
				.create(orgId, detectionInput({ destinationIds: [theirs.id] }))
				.pipe(Effect.flip)

			assert.strictEqual(refused._tag, "@maple/http/errors/AuditDetectionInvalidError")
		}).pipe(Effect.provide(layer))
	})

	// Rule names are unique per org across every kind of rule: the index would answer a 500.
	it.effect("refuses a name another detection or another alert rule already has", () => {
		const { layer } = harness()
		return Effect.gen(function* () {
			const alerts = yield* alertServices
			const detections = yield* AuditDetectionsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			yield* detections.create(orgId, detectionInput({ name: "Members added" }))
			const other = yield* detections.create(orgId, detectionInput({ name: "Tokens created" }))

			const duplicate = yield* detections
				.create(orgId, detectionInput({ name: "Members added" }))
				.pipe(Effect.flip)
			const sameAsRule = yield* detections
				.create(orgId, detectionInput({ name: rule.name }))
				.pipe(Effect.flip)
			const renamed = yield* detections
				.update(orgId, other.id, { name: "Members added", updatedBy: userId })
				.pipe(Effect.flip)

			assert.deepStrictEqual(
				[duplicate._tag, sameAsRule._tag, renamed._tag],
				[
					"@maple/http/errors/AuditDetectionInvalidError",
					"@maple/http/errors/AuditDetectionInvalidError",
					"@maple/http/errors/AuditDetectionInvalidError",
				],
			)
			// The same name is free in another org.
			yield* detections.create(otherOrgId, detectionInput({ name: "Members added" }))
		}).pipe(Effect.provide(layer))
	})

	it.effect("caps an org's detections and leaves another org's room alone", () => {
		const { layer } = harness()
		return Effect.gen(function* () {
			const detections = yield* AuditDetectionsService
			const create = (index: number) =>
				detections.create(orgId, detectionInput({ name: `Detection ${index}` }))
			yield* Effect.forEach(Arr.range(1, MAX_AUDIT_DETECTIONS_PER_ORG), create, { discard: true })

			const refused = yield* create(MAX_AUDIT_DETECTIONS_PER_ORG + 1).pipe(Effect.flip)

			assert.strictEqual(refused._tag, "@maple/http/errors/AuditDetectionInvalidError")
			assert.lengthOf(yield* detections.list(orgId), MAX_AUDIT_DETECTIONS_PER_ORG)
			yield* detections.create(otherOrgId, detectionInput())
		}).pipe(Effect.provide(layer))
	})

	it.effect("removes the rule with its state and incidents, open ones included", () => {
		const { layer, testDb } = harness(3)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const detections = yield* AuditDetectionsService
			const created = yield* detections.create(orgId, detectionInput())
			yield* alerts.runSchedulerTick()
			const open = (yield* alerts.listIncidents(orgId)).incidents
			assert.deepStrictEqual(
				Arr.map(open, (incident) => [incident.ruleId, incident.status]),
				[[created.id, "open"]],
			)

			assert.strictEqual(yield* detections.remove(orgId, created.id), created.id)

			const left = yield* Effect.promise(() =>
				queryFirstRow<{ rules: number; incidents: number; states: number }>(
					testDb,
					`select (select count(*)::int from alert_rules where id = $1) as rules,
					        (select count(*)::int from alert_incidents where rule_id = $1) as incidents,
					        (select count(*)::int from alert_rule_states where rule_id = $1) as states`,
					[created.id],
				),
			)
			assert.deepStrictEqual(left, { rules: 0, incidents: 0, states: 0 })
			assert.lengthOf(yield* detections.list(orgId), 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("answers not found for an id that is not one of the org's detections", () => {
		const { layer } = harness()
		return Effect.gen(function* () {
			const alerts = yield* alertServices
			const detections = yield* AuditDetectionsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			// Another kind of rule is edited and deleted through its own owner, never from here.
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			const theirs = yield* detections.create(otherOrgId, detectionInput())

			const outcomes = yield* Effect.all([
				refusal(detections.get(orgId, theirs.id)),
				refusal(detections.update(orgId, theirs.id, { threshold: 9, updatedBy: userId })),
				refusal(detections.remove(orgId, theirs.id)),
				refusal(detections.update(orgId, rule.id, { threshold: 9, updatedBy: userId })),
				refusal(detections.remove(orgId, rule.id)),
			])

			assert.deepStrictEqual(Arr.dedupe(outcomes), ["@maple/http/errors/AuditDetectionNotFoundError"])
			assert.lengthOf((yield* alerts.listRules(orgId)).rules, 1)
			assert.strictEqual((yield* detections.get(otherOrgId, theirs.id)).threshold, 3)
		}).pipe(Effect.provide(layer))
	})

	it.effect(
		"the generic rule APIs refuse to create, edit or delete a detection's rule and do not list it",
		() => {
			const { layer } = harness()
			return Effect.gen(function* () {
				const alerts = yield* alertServices
				const detections = yield* AuditDetectionsService
				const created = yield* detections.create(orgId, detectionInput())
				const request = new AlertRuleUpsertRequest({
					name: "Sneaky detection",
					severity: "critical",
					signalType: "audit",
					comparator: "gte",
					threshold: 1,
					windowMinutes: 5,
				})

				assert.lengthOf((yield* alerts.listRules(orgId)).rules, 0)
				const refusedCreate = yield* alerts
					.createRule(orgId, userId, adminRoles, request)
					.pipe(Effect.flip)
				const refusedEdit = yield* alerts
					.updateRule(orgId, userId, adminRoles, created.id, request)
					.pipe(Effect.flip)
				const refusedDelete = yield* alerts
					.deleteRule(orgId, adminRoles, created.id)
					.pipe(Effect.flip)

				assert.deepStrictEqual(
					[refusedCreate._tag, refusedEdit._tag, refusedDelete._tag],
					[
						"@maple/http/errors/AlertValidationError",
						"@maple/http/errors/AlertValidationError",
						"@maple/http/errors/AlertRuleNotFoundError",
					],
				)
				// The refusal says where a detection is managed instead.
				assert.include(refusedEdit.message, "Security hub")
				assert.deepStrictEqual(yield* detections.list(orgId), [created])
			}).pipe(Effect.provide(layer))
		},
	)
})
