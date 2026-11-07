import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Clock, Duration, Effect, Exit, Order, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	AlertForbiddenError,
	AlertMaintenanceWindowCreateRequest,
	AlertMaintenanceWindowNotFoundError,
	AlertMaintenanceWindowUpdateRequest,
	AlertRuleId,
	AlertValidationError,
	IsoDateTimeString,
	type AlertMaintenanceSchedule,
	type AlertMaintenanceWindowId,
	type AlertSilenceMatchers,
} from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AlertMaintenanceWindowsService } from "./AlertMaintenanceWindowsService"
import { AlertSilencesService } from "./AlertSilencesService"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminRoles,
	asOrgId,
	asUserId,
	getError,
	makeLayer,
	makeWarehouseStub,
	memberRoles,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const iso = Schema.decodeUnknownSync(IsoDateTimeString)
const at = (ms: number) => iso(new Date(ms).toISOString())
const orgId = asOrgId("org_maintenance")
const otherOrgId = asOrgId("org_maintenance_other")
const userId = asUserId("user_maintenance")
const MINUTE = 60_000

// DEFAULT_CLOCK_EPOCH_MS is Tuesday 2023-11-14 22:13:20 UTC.
const nightly: AlertMaintenanceSchedule = {
	_tag: "weekly",
	timeZone: "UTC",
	days: ["tue", "wed", "thu"],
	startTime: "23:30",
	durationMinutes: 60,
}
const TUE_2330 = Date.parse("2023-11-14T23:30:00Z")
const WED_2330 = Date.parse("2023-11-15T23:30:00Z")
const THU_2330 = Date.parse("2023-11-16T23:30:00Z")

const layer = () => makeLayer(createTestDb(trackedDbs), makeWarehouseStub({ tracesAggregateRows: [] }))

const createWindow = (
	options: {
		readonly schedule?: AlertMaintenanceSchedule
		readonly matchers?: AlertSilenceMatchers
		readonly org?: typeof orgId
		readonly enabled?: boolean
	} = {},
) =>
	AlertMaintenanceWindowsService.use((windows) =>
		windows.create(
			options.org ?? orgId,
			userId,
			adminRoles,
			new AlertMaintenanceWindowCreateRequest({
				name: "Nightly DB",
				reason: "vacuum",
				matchers: options.matchers ?? { services: ["checkout"] },
				schedule: options.schedule ?? nightly,
				...(options.enabled === undefined ? undefined : { enabled: options.enabled }),
			}),
		),
	)

const byStart = Order.mapInput(Order.Number, (silence: { readonly startsAt: string }) =>
	Date.parse(silence.startsAt),
)

/** The window's silences, in start order. */
const occurrenceSilences = (windowId: AlertMaintenanceWindowId, org = orgId) =>
	AlertSilencesService.use((silences) => silences.list(org)).pipe(
		Effect.map((response) =>
			Arr.sort(
				Arr.filter(response.silences, (silence) => silence.maintenanceWindowId === windowId),
				byStart,
			),
		),
	)

/** The window's silences as `[startsAt, endsAt]`. */
const windows = (windowId: AlertMaintenanceWindowId, org = orgId) =>
	occurrenceSilences(windowId, org).pipe(
		Effect.map((silences) => Arr.map(silences, (silence) => [silence.startsAt, silence.endsAt])),
	)

describe("AlertMaintenanceWindowsService", () => {
	it.effect("writes the occurrences of the next 48 hours as silences when a window is created", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const window = yield* createWindow()

			const silences = yield* occurrenceSilences(window.id)
			assert.deepStrictEqual(
				Arr.map(silences, (s) => [s.startsAt, s.endsAt]),
				[
					[at(TUE_2330), at(TUE_2330 + 60 * MINUTE)],
					[at(WED_2330), at(WED_2330 + 60 * MINUTE)],
				],
			)
			assert.strictEqual(silences[0]?.reason, "Maintenance: Nightly DB (vacuum)")
			assert.deepStrictEqual(silences[0]?.matchers, { services: ["checkout"] })
			assert.strictEqual(silences[0]?.createdBy, userId)
			assert.deepStrictEqual(window.nextOccurrence, {
				startsAt: at(TUE_2330),
				endsAt: at(TUE_2330 + 60 * MINUTE),
			})
		}).pipe(Effect.provide(layer())),
	)

	it.effect("materializes idempotently and extends the horizon as time passes", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const service = yield* AlertMaintenanceWindowsService
			const window = yield* createWindow()
			const before = yield* occurrenceSilences(window.id)

			const first = yield* service.materialize(DEFAULT_CLOCK_EPOCH_MS)
			yield* service.materialize(DEFAULT_CLOCK_EPOCH_MS)
			const again = yield* occurrenceSilences(window.id)
			assert.deepStrictEqual(
				Arr.map(again, (s) => s.id),
				Arr.map(before, (s) => s.id),
			)
			assert.strictEqual(first.windows, 1)
			assert.strictEqual(first.failures, 0)

			yield* TestClock.adjust(Duration.hours(24))
			const now = yield* Clock.currentTimeMillis
			yield* service.materialize(now)
			assert.deepStrictEqual(yield* windows(window.id), [
				[at(TUE_2330), at(TUE_2330 + 60 * MINUTE)],
				[at(WED_2330), at(WED_2330 + 60 * MINUTE)],
				[at(THU_2330), at(THU_2330 + 60 * MINUTE)],
			])
		}).pipe(Effect.provide(layer())),
	)

	it.effect("materializes every org's enabled windows and skips disabled ones", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const service = yield* AlertMaintenanceWindowsService
			const enabled = yield* createWindow({ org: otherOrgId })
			const disabled = yield* createWindow({ enabled: false })
			assert.deepStrictEqual(yield* windows(disabled.id), [])

			const result = yield* service.materialize(DEFAULT_CLOCK_EPOCH_MS)
			assert.strictEqual(result.windows, 1)
			assert.lengthOf(yield* windows(enabled.id, otherOrgId), 2)
			assert.deepStrictEqual(yield* windows(disabled.id), [])
		}).pipe(Effect.provide(layer())),
	)

	it.effect("rewrites future occurrences when the schedule changes", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const service = yield* AlertMaintenanceWindowsService
			const window = yield* createWindow()

			yield* service.update(
				orgId,
				userId,
				adminRoles,
				window.id,
				new AlertMaintenanceWindowUpdateRequest({ schedule: { ...nightly, startTime: "23:45" } }),
			)
			assert.deepStrictEqual(yield* windows(window.id), [
				[at(TUE_2330 + 15 * MINUTE), at(TUE_2330 + 75 * MINUTE)],
				[at(WED_2330 + 15 * MINUTE), at(WED_2330 + 75 * MINUTE)],
			])
		}).pipe(Effect.provide(layer())),
	)

	it.effect("keeps a running occurrence going with the window's new matchers and end", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const service = yield* AlertMaintenanceWindowsService
			const window = yield* createWindow()
			yield* TestClock.setTime(TUE_2330 + 10 * MINUTE)

			yield* service.update(
				orgId,
				userId,
				adminRoles,
				window.id,
				new AlertMaintenanceWindowUpdateRequest({
					matchers: { services: ["checkout", "cart"] },
					schedule: { ...nightly, durationMinutes: 90 },
				}),
			)
			const [running, next] = yield* occurrenceSilences(window.id)
			assert.strictEqual(running?.status, "active")
			assert.strictEqual(running?.startsAt, at(TUE_2330))
			assert.strictEqual(running?.endsAt, at(TUE_2330 + 90 * MINUTE))
			assert.deepStrictEqual(running?.matchers, { services: ["checkout", "cart"] })
			assert.strictEqual(next?.endsAt, at(WED_2330 + 90 * MINUTE))
		}).pipe(Effect.provide(layer())),
	)

	it.effect("ends a running occurrence now and drops future ones when the window is deleted", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const service = yield* AlertMaintenanceWindowsService
			const window = yield* createWindow()
			const deletedAt = TUE_2330 + 10 * MINUTE
			yield* TestClock.setTime(deletedAt)

			yield* service.delete(orgId, userId, adminRoles, window.id)

			assert.deepStrictEqual(yield* windows(window.id), [[at(TUE_2330), at(deletedAt)]])
			const missing = yield* Effect.exit(service.get(orgId, window.id))
			assert.instanceOf(getError(missing), AlertMaintenanceWindowNotFoundError)
			// A later pass writes nothing for a deleted window.
			yield* service.materialize(deletedAt)
			assert.lengthOf(yield* windows(window.id), 1)
		}).pipe(Effect.provide(layer())),
	)

	it.effect("ends the running occurrence when the window is disabled", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const service = yield* AlertMaintenanceWindowsService
			const window = yield* createWindow()
			const disabledAt = TUE_2330 + 10 * MINUTE
			yield* TestClock.setTime(disabledAt)

			const updated = yield* service.update(
				orgId,
				userId,
				adminRoles,
				window.id,
				new AlertMaintenanceWindowUpdateRequest({ enabled: false }),
			)
			assert.isNull(updated.nextOccurrence)
			assert.deepStrictEqual(yield* windows(window.id), [[at(TUE_2330), at(disabledAt)]])
		}).pipe(Effect.provide(layer())),
	)

	it.effect("refuses members, ended one-off windows and unknown rules", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const service = yield* AlertMaintenanceWindowsService
			const request = (schedule: AlertMaintenanceSchedule, matchers: AlertSilenceMatchers) =>
				new AlertMaintenanceWindowCreateRequest({ name: "x", matchers, schedule })

			const denied = yield* Effect.exit(
				service.create(orgId, userId, memberRoles, request(nightly, { services: ["checkout"] })),
			)
			const ended = yield* Effect.exit(
				service.create(
					orgId,
					userId,
					adminRoles,
					request(
						{
							_tag: "once",
							startsAt: at(DEFAULT_CLOCK_EPOCH_MS - 120 * MINUTE),
							endsAt: at(DEFAULT_CLOCK_EPOCH_MS - 60 * MINUTE),
						},
						{ services: ["checkout"] },
					),
				),
			)
			const unknownRule = yield* Effect.exit(
				service.create(
					orgId,
					userId,
					adminRoles,
					request(nightly, {
						ruleIds: [Schema.decodeSync(AlertRuleId)("0b8f7c1e-2f61-4f1e-9d2a-3c4b5d6e7f80")],
					}),
				),
			)
			assert.instanceOf(getError(denied), AlertForbiddenError)
			assert.instanceOf(getError(ended), AlertValidationError)
			assert.instanceOf(getError(unknownRule), AlertValidationError)
			assert.isTrue(Exit.isFailure(unknownRule))
			assert.lengthOf((yield* service.list(orgId)).windows, 0)
		}).pipe(Effect.provide(layer())),
	)
})
