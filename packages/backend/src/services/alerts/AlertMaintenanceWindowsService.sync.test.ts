/**
 * How a window's silences follow its schedule through edits, passes and races: each running
 * occurrence keeps its own row, an edit ends or reopens running rows, a pass holding a stale
 * read writes nothing, and window-owned silences are managed only through the window.
 */
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Option, Order, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	AlertMaintenanceWindowCreateRequest,
	AlertMaintenanceWindowUpdateRequest,
	AlertSilenceCreateRequest,
	AlertSilenceUpdateRequest,
	AlertValidationError,
	IsoDateTimeString,
	type AlertMaintenanceSchedule,
	type AlertMaintenanceWindowId,
} from "@maple/domain/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { AlertMaintenanceWindowsService } from "./AlertMaintenanceWindowsService"
import { AlertSilencesService } from "./AlertSilencesService"
import { syncWindow } from "./alert-maintenance-window-sync"
import {
	decodeMaintenanceWindow,
	selectBaselineExclusions,
	selectMaintenanceWindows,
} from "./alert-maintenance-window-store"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminRoles,
	asOrgId,
	asUserId,
	getError,
	makeLayer,
	makeWarehouseStub,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const iso = Schema.decodeUnknownSync(IsoDateTimeString)
const at = (ms: number) => iso(new Date(ms).toISOString())
const orgId = asOrgId("org_maintenance_sync")
const userId = asUserId("user_maintenance_sync")
const MINUTE = 60_000
const HOUR = 60 * MINUTE
// Tuesday 2023-11-14 22:13:20 UTC.
const NOW = DEFAULT_CLOCK_EPOCH_MS
const TUE_2330 = Date.parse("2023-11-14T23:30:00Z")

const setup = () => {
	const testDb = createTestDb(trackedDbs)
	const layer = Layer.mergeAll(
		makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: [] })),
		testDb.layer,
	)
	return { testDb, layer }
}

const nightly: AlertMaintenanceSchedule = {
	_tag: "weekly",
	timeZone: "UTC",
	days: ["tue", "wed", "thu"],
	startTime: "23:30",
	durationMinutes: 60,
}

const createWindow = (schedule: AlertMaintenanceSchedule, name = "Nightly DB") =>
	AlertMaintenanceWindowsService.use((windows) =>
		windows.create(
			orgId,
			userId,
			adminRoles,
			new AlertMaintenanceWindowCreateRequest({ name, matchers: { services: ["checkout"] }, schedule }),
		),
	)

const updateWindow = (windowId: AlertMaintenanceWindowId, request: AlertMaintenanceWindowUpdateRequest) =>
	AlertMaintenanceWindowsService.use((windows) =>
		windows.update(orgId, userId, adminRoles, windowId, request),
	)

const byStart = Order.mapInput(Order.Number, (silence: { readonly startsAt: string }) =>
	Date.parse(silence.startsAt),
)

const occurrenceSilences = (windowId: AlertMaintenanceWindowId) =>
	AlertSilencesService.use((silences) => silences.list(orgId)).pipe(
		Effect.map((response) =>
			Arr.sort(
				Arr.filter(response.silences, (silence) => silence.maintenanceWindowId === windowId),
				byStart,
			),
		),
	)

const spans = (windowId: AlertMaintenanceWindowId) =>
	occurrenceSilences(windowId).pipe(
		Effect.map((silences) => Arr.map(silences, (silence) => [silence.startsAt, silence.endsAt])),
	)

const once = (startsAtMs: number, endsAtMs: number): AlertMaintenanceSchedule => ({
	_tag: "once",
	startsAt: at(startsAtMs),
	endsAt: at(endsAtMs),
})

describe("maintenance window sync", () => {
	it.effect("pairs each running occurrence with its own row when occurrences overlap", () => {
		const { layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const window = yield* createWindow({
				_tag: "weekly",
				timeZone: "UTC",
				days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
				startTime: "23:30",
				durationMinutes: 25 * 60,
			})
			const later = Date.parse("2023-11-15T23:45:00Z")
			yield* TestClock.setTime(later)
			const service = yield* AlertMaintenanceWindowsService
			yield* service.materialize(later)
			yield* service.materialize(later + 15 * MINUTE)

			const silences = yield* occurrenceSilences(window.id)
			// Every row keeps the end of the occurrence it starts: 25 hours after its own start.
			assert.isTrue(silences.length >= 3)
			assert.deepStrictEqual(
				Arr.map(silences, (s) => Date.parse(s.endsAt) - Date.parse(s.startsAt)),
				Arr.map(silences, () => 25 * HOUR),
			)
			assert.lengthOf(
				Arr.filter(silences, (s) => s.status === "active"),
				2,
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("ends the running silence when a one-off window is postponed", () => {
		const { layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const start = NOW + HOUR
			const window = yield* createWindow(once(start, start + 4 * HOUR))
			yield* TestClock.setTime(start + HOUR)

			yield* updateWindow(
				window.id,
				new AlertMaintenanceWindowUpdateRequest({
					schedule: once(start + 24 * HOUR, start + 26 * HOUR),
				}),
			)
			assert.deepStrictEqual(yield* spans(window.id), [
				[at(start), at(start + HOUR)],
				[at(start + 24 * HOUR), at(start + 26 * HOUR)],
			])
		}).pipe(Effect.provide(layer))
	})

	it.effect(
		"ends the running silence when its weekday is removed, its start moves or it is cut short",
		() => {
			const cases: ReadonlyArray<readonly [string, AlertMaintenanceSchedule]> = [
				["weekday removed", { ...nightly, days: ["wed", "thu"] }],
				["start moved", { ...nightly, startTime: "23:50" }],
				["duration already over", { ...nightly, durationMinutes: 5 }],
			]
			return Effect.forEach(cases, ([label, schedule]) => {
				const { layer } = setup()
				return Effect.gen(function* () {
					yield* TestClock.setTime(NOW)
					const window = yield* createWindow(nightly)
					const editedAt = TUE_2330 + 10 * MINUTE
					yield* TestClock.setTime(editedAt)

					yield* updateWindow(window.id, new AlertMaintenanceWindowUpdateRequest({ schedule }))
					const tuesday = Arr.findFirst(
						yield* occurrenceSilences(window.id),
						(s) => s.startsAt === at(TUE_2330),
					)
					assert.strictEqual(
						Option.map(tuesday, (s) => s.endsAt).pipe(Option.getOrUndefined),
						at(editedAt),
						label,
					)
				}).pipe(Effect.provide(layer))
			}).pipe(Effect.asVoid)
		},
	)

	it.effect("reopens the running occurrence when a window is disabled and enabled again", () => {
		const { layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const start = NOW + HOUR
			const window = yield* createWindow(once(start, start + 4 * HOUR))
			yield* TestClock.setTime(start + HOUR)
			yield* updateWindow(window.id, new AlertMaintenanceWindowUpdateRequest({ enabled: false }))
			assert.deepStrictEqual(yield* spans(window.id), [[at(start), at(start + HOUR)]])

			yield* TestClock.setTime(start + HOUR + 5 * MINUTE)
			yield* updateWindow(window.id, new AlertMaintenanceWindowUpdateRequest({ enabled: true }))
			const [reopened] = yield* occurrenceSilences(window.id)
			assert.strictEqual(reopened?.status, "active")
			assert.strictEqual(reopened?.endsAt, at(start + 4 * HOUR))
		}).pipe(Effect.provide(layer))
	})

	it.effect("reopens a one-off window that just ended when its end is extended", () => {
		const { layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const start = NOW + HOUR
			const window = yield* createWindow(once(start, start + 2 * HOUR))
			yield* TestClock.setTime(start + 2 * HOUR + MINUTE)

			yield* updateWindow(
				window.id,
				new AlertMaintenanceWindowUpdateRequest({ schedule: once(start, start + 4 * HOUR) }),
			)
			const [extended] = yield* occurrenceSilences(window.id)
			assert.strictEqual(extended?.status, "active")
			assert.strictEqual(extended?.endsAt, at(start + 4 * HOUR))
		}).pipe(Effect.provide(layer))
	})

	it.effect("writes nothing from a stale read of a window edited or disabled since", () => {
		const { layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const window = yield* createWindow(nightly)
			const database = yield* Database
			const readStale = database.execute((db) =>
				db.run(selectMaintenanceWindows().where(($) => [$.orgId.eq(orgId), $.id.eq(window.id)])),
			)
			const [staleRow] = yield* readStale
			const stale = Option.getOrThrow(decodeMaintenanceWindow(staleRow))

			yield* TestClock.setTime(NOW + MINUTE)
			yield* updateWindow(
				window.id,
				new AlertMaintenanceWindowUpdateRequest({ schedule: { ...nightly, startTime: "23:45" } }),
			)
			const after = yield* spans(window.id)

			const written = yield* database.execute((db) =>
				db.transaction(syncWindow(db, () => crypto.randomUUID(), stale, NOW + MINUTE, false)),
			)
			assert.strictEqual(written, 0)
			assert.deepStrictEqual(yield* spans(window.id), after)

			yield* updateWindow(window.id, new AlertMaintenanceWindowUpdateRequest({ enabled: false }))
			const [disabledRow] = yield* readStale
			const disabled = Option.getOrThrow(decodeMaintenanceWindow(disabledRow))
			const writtenDisabled = yield* database.execute((db) =>
				db.transaction(syncWindow(db, () => crypto.randomUUID(), disabled, NOW + MINUTE, false)),
			)
			assert.strictEqual(writtenDisabled, 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("drops a future row that is not one of the window's occurrences on the next pass", () => {
		const { testDb, layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const window = yield* createWindow(nightly)
			const expected = yield* spans(window.id)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO alert_silences
					   (id, org_id, reason, matchers_json, starts_at, ends_at, maintenance_window_id,
					    exclude_from_baselines, created_at, updated_at, created_by, updated_by)
					 VALUES ('3b8f7c1e-2f61-4f1e-9d2a-3c4b5d6e7f80', $1, 'stale', '{"services":["checkout"]}',
					         to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), $4, true, now(), now(), 'u', 'u')`,
					[orgId, NOW + 3 * HOUR, NOW + 4 * HOUR, window.id],
				),
			)
			yield* AlertMaintenanceWindowsService.use((service) => service.materialize(NOW))
			assert.deepStrictEqual(yield* spans(window.id), expected)
		}).pipe(Effect.provide(layer))
	})

	it.effect("pages through every enabled window and skips one-off windows that have ended", () => {
		const { layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const weekly = yield* Effect.forEach(Arr.range(1, 5), (n) =>
				createWindow(nightly, `Nightly ${n}`),
			)
			yield* createWindow(once(NOW + HOUR, NOW + 2 * HOUR), "Done")

			const later = NOW + 3 * HOUR
			yield* TestClock.setTime(later)
			const result = yield* AlertMaintenanceWindowsService.use((service) =>
				service.materialize(later, { pageSize: 2 }),
			)
			assert.strictEqual(result.windows, 5)
			assert.strictEqual(result.pages, 3)
			assert.isFalse(result.budgetExhausted)
			assert.strictEqual(weekly.length, 5)
		}).pipe(Effect.provide(layer))
	})

	it.effect("leaves ended one-off windows out of the org's window cap", () => {
		const { testDb, layer } = setup()
		const seedWindows = (onceEndsAtMs: number | null) =>
			executeSql(
				testDb,
				`INSERT INTO alert_maintenance_windows
				   (id, org_id, name, reason, matchers_json, schedule_json, exclude_from_baselines, enabled,
				    once_ends_at, created_at, updated_at, created_by, updated_by)
				 SELECT gen_random_uuid()::text, $1, 'seeded ' || n, null, '{"services":["x"]}',
				        '{"_tag":"weekly","timeZone":"UTC","days":["sat"],"startTime":"02:00","durationMinutes":60}',
				        true, false, CASE WHEN $2::bigint IS NULL THEN NULL ELSE to_timestamp($2::bigint / 1000.0) END,
				        now(), now(), 'u', 'u'
				 FROM generate_series(1, 100) AS n`,
				[orgId, onceEndsAtMs],
			)
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			yield* Effect.promise(() => seedWindows(NOW - HOUR))
			yield* createWindow(nightly, "Allowed")

			yield* Effect.promise(() => seedWindows(null))
			const refused = yield* Effect.exit(createWindow(nightly, "Refused"))
			assert.instanceOf(getError(refused), AlertValidationError)
		}).pipe(Effect.provide(layer))
	})

	it.effect("leaves window silences out of the open-silence cap", () => {
		const { testDb, layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO alert_silences
					   (id, org_id, reason, matchers_json, starts_at, ends_at, maintenance_window_id,
					    exclude_from_baselines, created_at, updated_at, created_by, updated_by)
					 SELECT gen_random_uuid()::text, $1, 'Maintenance', '{"services":["x"]}',
					        to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), gen_random_uuid()::text,
					        true, now(), now(), 'u', 'u'
					 FROM generate_series(1, 200)`,
					[orgId, NOW, NOW + HOUR],
				),
			)
			const created = yield* AlertSilencesService.use((silences) =>
				silences.create(
					orgId,
					userId,
					adminRoles,
					new AlertSilenceCreateRequest({
						reason: "deploy",
						matchers: { services: ["checkout"] },
						endsAt: at(NOW + HOUR),
					}),
				),
			)
			assert.strictEqual(created.status, "active")
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses to end or edit a window's silence through the silence API", () => {
		const { layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const window = yield* createWindow(nightly, "Nightly DB")
			const [first] = yield* occurrenceSilences(window.id)
			const silences = yield* AlertSilencesService
			const ended = yield* Effect.exit(silences.end(orgId, userId, adminRoles, first.id))
			const edited = yield* Effect.exit(
				silences.update(
					orgId,
					userId,
					adminRoles,
					first.id,
					new AlertSilenceUpdateRequest({ endsAt: at(NOW + 10 * HOUR) }),
				),
			)
			assert.deepStrictEqual(
				Arr.map([ended, edited], (exit) => {
					const error = getError(exit)
					return Schema.is(AlertValidationError)(error) ? error.message : String(error)
				}),
				Arr.makeBy(
					2,
					() =>
						"This silence belongs to maintenance window Nightly DB; edit or disable the window instead",
				),
			)
			assert.deepStrictEqual(yield* spans(window.id), [
				[first.startsAt, first.endsAt],
				[at(TUE_2330 + 24 * HOUR), at(TUE_2330 + 25 * HOUR)],
			])
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses to turn back on a one-off window that already ended", () => {
		const { layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const window = yield* createWindow(once(NOW, NOW + HOUR))
			yield* updateWindow(window.id, new AlertMaintenanceWindowUpdateRequest({ enabled: false }))
			yield* TestClock.setTime(NOW + 2 * HOUR)
			const reenabled = yield* Effect.exit(
				updateWindow(window.id, new AlertMaintenanceWindowUpdateRequest({ enabled: true })),
			)
			const error = getError(reenabled)
			assert.strictEqual(
				Schema.is(AlertValidationError)(error) ? error.message : String(error),
				"A one-off maintenance window must end in the future",
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("says a deleted window's silence cannot be edited, without naming an id", () => {
		const { layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const window = yield* createWindow(nightly, "Nightly DB")
			const [first] = yield* occurrenceSilences(window.id)
			// Deleted mid-occurrence: that occurrence's silence is kept, ended at the delete.
			yield* TestClock.setTime(TUE_2330 + 10 * MINUTE)
			yield* AlertMaintenanceWindowsService.use((service) =>
				service.delete(orgId, userId, adminRoles, window.id),
			)
			const silences = yield* AlertSilencesService
			const error = getError(yield* Effect.exit(silences.end(orgId, userId, adminRoles, first.id)))
			assert.strictEqual(
				Schema.is(AlertValidationError)(error) ? error.message : String(error),
				"This silence came from a maintenance window that was deleted, so it cannot be edited",
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("keeps a past occurrence's baseline exclusion after its window is deleted", () => {
		const { layer } = setup()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const window = yield* createWindow(once(NOW, NOW + 4 * HOUR))
			const deletedAt = NOW + HOUR
			yield* TestClock.setTime(deletedAt)
			yield* AlertMaintenanceWindowsService.use((service) =>
				service.delete(orgId, userId, adminRoles, window.id),
			)

			const database = yield* Database
			const exclusions = yield* database.execute((db) =>
				selectBaselineExclusions(db, orgId, NOW - 7 * 24 * HOUR, deletedAt + HOUR),
			)
			assert.deepStrictEqual(
				Arr.map(exclusions, (exclusion) => exclusion.ranges),
				[[{ startsAtMs: NOW, endsAtMs: deletedAt }]],
			)
			assert.isTrue(exclusions[0]?.covers("checkout", "production"))
			assert.isFalse(exclusions[0]?.covers("cart", "production"))
		}).pipe(Effect.provide(layer))
	})
})
