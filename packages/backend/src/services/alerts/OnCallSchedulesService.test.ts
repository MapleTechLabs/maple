import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	AlertValidationError,
	OnCallOverrideCreateRequest,
	OnCallScheduleCreateRequest,
	OnCallScheduleUpdateRequest,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { Effect, Exit, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { getError, stubOrgMembersService } from "./alerts-service-test-support"
import { OnCallSchedulesService } from "./OnCallSchedulesService"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const ORG = asOrgId("org_oncall")
const OTHER_ORG = asOrgId("org_oncall_other")
const ADMIN = [asRoleName("org:admin")]
const MEMBER = [asRoleName("org:member")]
const ana = asUserId("user_ana")
const ben = asUserId("user_ben")
const chen = asUserId("user_chen")
const at = (iso: string) => Date.parse(iso)

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = (testDb: TestDb) =>
	Layer.effect(OnCallSchedulesService, OnCallSchedulesService.make).pipe(
		Layer.provide(
			Layer.merge(
				testDb.layer,
				Layer.succeed(
					OrgMembersService,
					stubOrgMembersService([
						{ userId: ana, email: "ana@acme.test", name: "Ana Alves", imageUrl: null },
						{ userId: ben, email: "ben@acme.test", name: "Ben Brook", imageUrl: null },
						{ userId: chen, email: "chen@acme.test", name: null, imageUrl: null },
					]),
				),
			),
		),
	)

// Weekly handoff, Monday 09:00 Europe/Berlin; Ana holds the week of Monday 2026-11-09.
const weekly = new OnCallScheduleCreateRequest({
	name: "Checkout primary",
	timeZone: "Europe/Berlin",
	layers: [
		{
			name: "Primary",
			participants: [ana, ben, chen],
			rotation: { kind: "weekly", handoffWeekday: "mon", handoffTime: "09:00" },
			startsAt: at("2026-11-09T08:00:00Z"),
		},
	],
})

// Thursday 2026-11-12 18:00 to Friday 09:00, Berlin time.
const benCoversAna = new OnCallOverrideCreateRequest({
	userId: ben,
	startsAt: at("2026-11-12T17:00:00Z"),
	endsAt: at("2026-11-13T08:00:00Z"),
})

const errorTag = <A, E>(exit: Exit.Exit<A, E>) => {
	const error = getError(exit)
	return typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined
}

describe("OnCallSchedulesService", () => {
	it.effect("an override takes the shift it covers, and deleting it hands the shift back", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			assert.strictEqual(schedule.onCallNow?.userId, ana)

			const override = yield* schedules.createOverride(ORG, ana, ADMIN, schedule.id, benCoversAna)
			const thursdayEvening = at("2026-11-12T19:00:00Z")
			const covered = yield* schedules.onCallAt(ORG, schedule.id, thursdayEvening)
			assert.strictEqual(covered.shift?.userId, ben)
			assert.deepStrictEqual(covered.shift?.source, { kind: "override", overrideId: override.id })
			assert.strictEqual(covered.shift?.endsAt, "2026-11-13T08:00:00.000Z")

			const listed = yield* schedules.listOverrides(ORG, schedule.id)
			assert.deepStrictEqual(
				Arr.map(listed.overrides, (o) => o.id),
				[override.id],
			)

			yield* schedules.deleteOverride(ORG, ADMIN, schedule.id, override.id)
			const back = yield* schedules.onCallAt(ORG, schedule.id, thursdayEvening)
			assert.strictEqual(back.shift?.userId, ana)
			assert.deepStrictEqual(back.shift?.source, { kind: "layer", layerIndex: 0 })
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("renders the effective shifts with the override cut into the week", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			yield* schedules.createOverride(ORG, ana, ADMIN, schedule.id, benCoversAna)

			const render = yield* schedules.shifts(
				ORG,
				schedule.id,
				at("2026-11-09T08:00:00Z"),
				at("2026-11-23T08:00:00Z"),
			)
			assert.deepStrictEqual(
				Arr.map(render.final, (s) => [s.userId, s.startsAt, s.endsAt]),
				[
					[ana, "2026-11-09T08:00:00.000Z", "2026-11-12T17:00:00.000Z"],
					[ben, "2026-11-12T17:00:00.000Z", "2026-11-13T08:00:00.000Z"],
					[ana, "2026-11-13T08:00:00.000Z", "2026-11-16T08:00:00.000Z"],
					[ben, "2026-11-16T08:00:00.000Z", "2026-11-23T08:00:00.000Z"],
				],
			)
			const backwards = yield* Effect.exit(
				schedules.shifts(ORG, schedule.id, at("2026-11-23T08:00:00Z"), at("2026-11-09T08:00:00Z")),
			)
			assert.strictEqual(errorTag(backwards), "@maple/http/errors/AlertValidationError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("rejects participants and override users who are not workspace members", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const stranger = asUserId("user_zed")
			const [layer] = weekly.layers
			const created = yield* Effect.exit(
				schedules.create(
					ORG,
					ana,
					ADMIN,
					new OnCallScheduleCreateRequest({
						...weekly,
						layers: [{ ...layer, participants: [ana, stranger] }],
					}),
				),
			)
			assert.strictEqual(errorTag(created), "@maple/http/errors/AlertValidationError")
			const createdError = getError(created)
			assert.isTrue(
				Schema.is(AlertValidationError)(createdError) &&
					Str.includes("user_zed")(createdError.message),
			)

			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			const updated = yield* Effect.exit(
				schedules.update(
					ORG,
					ana,
					ADMIN,
					schedule.id,
					new OnCallScheduleUpdateRequest({ layers: [{ ...layer, participants: [stranger] }] }),
				),
			)
			assert.strictEqual(errorTag(updated), "@maple/http/errors/AlertValidationError")
			const override = yield* Effect.exit(
				schedules.createOverride(
					ORG,
					ana,
					ADMIN,
					schedule.id,
					new OnCallOverrideCreateRequest({ ...benCoversAna, userId: stranger }),
				),
			)
			assert.strictEqual(errorTag(override), "@maple/http/errors/AlertValidationError")
			assert.strictEqual((yield* schedules.list(ORG)).schedules.length, 1)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses overrides that are backwards, too long or already over", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			const attempt = (startsAt: string, endsAt: string) =>
				Effect.exit(
					schedules.createOverride(
						ORG,
						ana,
						ADMIN,
						schedule.id,
						new OnCallOverrideCreateRequest({
							userId: ben,
							startsAt: at(startsAt),
							endsAt: at(endsAt),
						}),
					),
				)
			const tags = yield* Effect.all([
				attempt("2026-11-12T10:00:00Z", "2026-11-12T09:00:00Z"),
				attempt("2026-11-12T10:00:00Z", "2027-02-12T10:00:00Z"),
				attempt("2026-11-01T10:00:00Z", "2026-11-02T10:00:00Z"),
			]).pipe(Effect.map(Arr.map(errorTag)))
			assert.deepStrictEqual(tags, [
				"@maple/http/errors/AlertValidationError",
				"@maple/http/errors/AlertValidationError",
				"@maple/http/errors/AlertValidationError",
			])
			// Started in the past but still running is a valid cover.
			const running = yield* attempt("2026-11-09T10:00:00Z", "2026-11-10T10:00:00Z")
			assert.isTrue(Exit.isSuccess(running))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("caps schedules per org and upcoming overrides per schedule", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO oncall_schedules
					   (id, org_id, name, time_zone, layers_json, created_at, updated_at, created_by, updated_by)
					 SELECT gen_random_uuid()::text, $1, 'Filler ' || n, 'UTC', layers_json, now(), now(), 'seed', 'seed'
					 FROM generate_series(1, 49) AS n, oncall_schedules WHERE id = $2`,
					[ORG, schedule.id],
				),
			)
			const fiftyFirst = yield* Effect.exit(schedules.create(ORG, ana, ADMIN, weekly))
			assert.strictEqual(errorTag(fiftyFirst), "@maple/http/errors/AlertValidationError")
			// The cap is per org.
			yield* schedules.create(OTHER_ORG, ana, ADMIN, weekly)

			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO oncall_overrides (id, org_id, schedule_id, user_id, starts_at, ends_at, created_by, created_at)
					 SELECT gen_random_uuid()::text, $1, $2, 'user_ben',
					        '2026-12-01T00:00:00Z'::timestamptz + n * interval '1 hour',
					        '2026-12-01T00:30:00Z'::timestamptz + n * interval '1 hour', 'seed', now()
					 FROM generate_series(1, 500) AS n`,
					[ORG, schedule.id],
				),
			)
			const overCap = yield* Effect.exit(
				schedules.createOverride(ORG, ana, ADMIN, schedule.id, benCoversAna),
			)
			assert.strictEqual(errorTag(overCap), "@maple/http/errors/AlertValidationError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("deleting a schedule deletes its overrides, and other orgs cannot see it", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			yield* schedules.createOverride(ORG, ana, ADMIN, schedule.id, benCoversAna)

			const foreign = yield* Effect.exit(schedules.get(OTHER_ORG, schedule.id))
			assert.strictEqual(errorTag(foreign), "@maple/http/errors/OnCallScheduleNotFoundError")
			const denied = yield* Effect.exit(schedules.delete(ORG, MEMBER, schedule.id))
			assert.strictEqual(errorTag(denied), "@maple/http/errors/AlertForbiddenError")

			yield* schedules.delete(ORG, ADMIN, schedule.id)
			const left = yield* Effect.promise(() =>
				testDb.pglite.query<{ n: number }>(
					`SELECT count(*)::int AS n FROM oncall_overrides WHERE schedule_id = $1`,
					[schedule.id],
				),
			)
			assert.deepStrictEqual(left.rows, [{ n: 0 }])
			const gone = yield* Effect.exit(schedules.get(ORG, schedule.id))
			assert.strictEqual(errorTag(gone), "@maple/http/errors/OnCallScheduleNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
