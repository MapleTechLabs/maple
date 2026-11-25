import * as Policy from "@maple/domain/policy"
import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	AlertMemberDirectoryNotConfiguredError,
	AlertMemberDirectoryUnavailableError,
	AlertValidationError,
	OnCallOverrideCreateRequest,
	OnCallScheduleCreateRequest,
	OnCallScheduleUpdateRequest,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { Effect, Exit, Layer, Option, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { getError, stubOrgMembersService } from "./alerts-service-test-support"
import { OnCallSchedulesService } from "./OnCallSchedulesService"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const ORG = asOrgId("org_oncall")
const OTHER_ORG = asOrgId("org_oncall_other")
const ADMIN = Policy.grantsOf([asRoleName("org:admin")])
const MEMBER = Policy.grantsOf([asRoleName("org:member")])
const ana = asUserId("user_ana")
const ben = asUserId("user_ben")
const chen = asUserId("user_chen")
const at = (iso: string) => Date.parse(iso)

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

/** A deployment with no member directory, as self-hosted runs. */
const noDirectoryLayer = (testDb: TestDb) => {
	const notConfigured = new AlertMemberDirectoryNotConfiguredError({
		message: "The member directory is not configured",
	})
	return Layer.effect(OnCallSchedulesService, OnCallSchedulesService.make).pipe(
		Layer.provide(
			Layer.merge(
				testDb.layer,
				Layer.succeed(OrgMembersService, {
					...stubOrgMembersService([]),
					listMembers: () => Effect.fail(notConfigured),
					resolveMembers: () => Effect.fail(notConfigured),
				}),
			),
		),
	)
}

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

	it.effect("reports the next two weeks' coverage gaps, earliest first", () => {
		const testDb = createTestDb(createdDbs)
		// Tuesday 2026-11-10 00:00 UTC.
		const now = at("2026-11-10T00:00:00Z")
		return Effect.gen(function* () {
			yield* TestClock.setTime(now)
			const schedules = yield* OnCallSchedulesService
			const covered = yield* schedules.create(ORG, ana, ADMIN, weekly)
			assert.deepStrictEqual(covered.coverageGaps, [])

			const weekdaysOnly = yield* schedules.create(
				ORG,
				ana,
				ADMIN,
				new OnCallScheduleCreateRequest({
					...weekly,
					name: "Business hours",
					layers: [
						{
							name: "Primary",
							participants: [ana],
							rotation: { kind: "weekly", handoffWeekday: "mon", handoffTime: "09:00" },
							startsAt: at("2026-11-09T08:00:00Z"),
							restrictions: [
								{
									weekdays: ["mon", "tue", "wed", "thu", "fri"],
									startTime: "09:00",
									endTime: "17:00",
								},
							],
						},
					],
				}),
			)
			const listed = yield* schedules.get(ORG, weekdaysOnly.id)
			assert.isNull(listed.onCallNow)
			// From now until Tuesday 09:00 Berlin, then every night and the weekends.
			assert.strictEqual(listed.coverageGaps[0]?.startsAt, "2026-11-10T00:00:00.000Z")
			assert.strictEqual(listed.coverageGaps[0]?.endsAt, "2026-11-10T08:00:00.000Z")
			assert.strictEqual(listed.coverageGaps[1]?.startsAt, "2026-11-10T16:00:00.000Z")
			assert.lengthOf(listed.coverageGaps, 11)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("names participants who left the org and passes their shift on", () => {
		const testDb = createTestDb(createdDbs)
		const directory = [
			{ userId: ana, email: "ana@acme.test", name: "Ana Alves", imageUrl: null },
			{ userId: ben, email: "ben@acme.test", name: "Ben Brook", imageUrl: null },
			{ userId: chen, email: "chen@acme.test", name: null, imageUrl: null },
		]
		return Effect.gen(function* () {
			// Ben's week: Monday 2026-11-16 09:00 Berlin onwards.
			yield* TestClock.setTime(at("2026-11-17T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			assert.deepStrictEqual(schedule.departedUserIds, [])
			directory.splice(1, 1)
			const read = yield* schedules.get(ORG, schedule.id)
			assert.deepStrictEqual(read.departedUserIds, [ben])
			assert.strictEqual(read.onCallNow?.userId, chen)
			assert.deepStrictEqual(read.coverageGaps, [])
		}).pipe(
			Effect.provide(
				Layer.effect(OnCallSchedulesService, OnCallSchedulesService.make).pipe(
					Layer.provide(
						Layer.merge(
							testDb.layer,
							Layer.succeed(OrgMembersService, stubOrgMembersService(directory)),
						),
					),
				),
			),
		)
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

	it.effect("creates schedules and overrides on a deployment with no member directory", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			const override = yield* schedules.createOverride(ORG, ana, ADMIN, schedule.id, benCoversAna)
			assert.strictEqual(override.userId, ben)
			assert.strictEqual((yield* schedules.memberNames(ORG)).size, 0)
		}).pipe(Effect.provide(noDirectoryLayer(testDb)))
	})

	it.effect("lists who is on call now even past a thousand older overrides in the org", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-12T19:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const busy = yield* schedules.create(
				ORG,
				ana,
				ADMIN,
				new OnCallScheduleCreateRequest({ ...weekly, name: "Busy" }),
			)
			const covered = yield* schedules.create(ORG, ana, ADMIN, weekly)
			// Past overrides on another schedule, all starting before the active one.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO oncall_overrides (id, org_id, schedule_id, user_id, starts_at, ends_at, created_by, created_at)
					 SELECT gen_random_uuid()::text, $1, $2, 'user_chen',
					        '2026-11-01T00:00:00Z'::timestamptz + n * interval '1 minute',
					        '2026-11-01T00:00:30Z'::timestamptz + n * interval '1 minute', 'seed', now()
					 FROM generate_series(1, 1200) AS n`,
					[ORG, busy.id],
				),
			)
			yield* schedules.createOverride(ORG, ana, ADMIN, covered.id, benCoversAna)
			const listed = yield* schedules.list(ORG)
			const row = Option.getOrUndefined(Arr.findFirst(listed.schedules, (s) => s.id === covered.id))
			assert.strictEqual(row?.onCallNow?.userId, ben)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("names members by their name only, never their email", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const names = yield* (yield* OnCallSchedulesService).memberNames(ORG)
			assert.deepStrictEqual([names.get(ana), names.get(chen)], ["Ana Alves", undefined])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
describe("OnCallSchedulesService calendar feed", () => {
	const summaries = (calendar: string) =>
		Arr.filter(Str.split("\r\n")(calendar), (line) => Str.startsWith("SUMMARY:")(line))

	it.effect("serves the schedule's shifts to whoever holds the link, and to nobody else", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			assert.isNull(schedule.calendarFeedCreatedAt)

			const feed = yield* schedules.createCalendarFeed(ORG, ADMIN, schedule.id, { replace: false })
			assert.strictEqual((yield* schedules.get(ORG, schedule.id)).calendarFeedCreatedAt, feed.createdAt)

			const calendar = Option.getOrThrow(yield* schedules.calendarFeed(feed.token))
			// A week back to 60 days on: Ana's week, then Ben's, then Chen, who has no display name.
			assert.deepStrictEqual(Arr.take(summaries(calendar), 3), [
				"SUMMARY:On call: Ana Alves (Checkout primary)",
				"SUMMARY:On call: Ben Brook (Checkout primary)",
				"SUMMARY:On call (Checkout primary)",
			])

			// A guess, a truncated link and a link of the wrong shape open nothing.
			assert.isTrue(Option.isNone(yield* schedules.calendarFeed(`${feed.token}x`)))
			assert.isTrue(Option.isNone(yield* schedules.calendarFeed(Str.slice(0, -1)(feed.token))))
			assert.isTrue(Option.isNone(yield* schedules.calendarFeed("")))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("keeps a shift's real start, end and event id from one fetch to the next", () => {
		const testDb = createTestDb(createdDbs)
		const eventsOf = (calendar: string) => {
			const lines = Str.split("\r\n")(calendar)
			const valuesOf = (property: string) =>
				Arr.map(
					Arr.filter(lines, (line) => Str.startsWith(`${property}:`)(line)),
					(line) => Str.slice(property.length + 1)(line),
				)
			return Arr.zip(valuesOf("UID"), Arr.zip(valuesOf("DTSTART"), valuesOf("DTEND")))
		}
		return Effect.gen(function* () {
			// Mid-week, at no round time: the feed's window starts and ends inside a weekly shift.
			yield* TestClock.setTime(at("2026-11-25T12:34:56Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			const feed = yield* schedules.createCalendarFeed(ORG, ADMIN, schedule.id, { replace: false })
			const first = eventsOf(Option.getOrThrow(yield* schedules.calendarFeed(feed.token)))
			yield* TestClock.adjust("5 minutes")
			const second = eventsOf(Option.getOrThrow(yield* schedules.calendarFeed(feed.token)))

			assert.deepStrictEqual(second, first)
			// Weekly handoff, Monday 09:00 Berlin: every event starts and ends on one, never mid-shift.
			assert.isAbove(first.length, 8)
			assert.isTrue(
				Arr.every(
					first,
					([, [start, end]]) => Str.endsWith("T080000Z")(start) && Str.endsWith("T080000Z")(end),
				),
			)
			// No schedule or user id can be read off an event id.
			assert.isTrue(Arr.every(first, ([uid]) => /^[0-9a-f]{32}@maple\.dev$/.test(uid)))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect(
		"gives a rotation of one person an event per handoff, and a long override its real dates",
		() => {
			const testDb = createTestDb(createdDbs)
			const startsOf = (calendar: string) =>
				Arr.map(
					Arr.filter(Str.split("\r\n")(calendar), (line) => Str.startsWith("DTSTART:")(line)),
					(line) => Str.slice("DTSTART:".length)(line),
				)
			const solo = new OnCallScheduleCreateRequest({
				name: "Solo",
				timeZone: "UTC",
				layers: [
					{
						name: "Primary",
						participants: [ana],
						rotation: { kind: "weekly", handoffWeekday: "mon", handoffTime: "09:00" },
						startsAt: at("2026-09-07T09:00:00Z"),
					},
				],
			})
			return Effect.gen(function* () {
				yield* TestClock.setTime(at("2026-10-01T12:00:00Z"))
				const schedules = yield* OnCallSchedulesService
				const schedule = yield* schedules.create(ORG, ana, ADMIN, solo)
				// Ben covers eighty days from tomorrow: far longer than the feed looks back.
				yield* schedules.createOverride(
					ORG,
					ana,
					ADMIN,
					schedule.id,
					new OnCallOverrideCreateRequest({
						userId: ben,
						startsAt: at("2026-10-02T10:00:00Z"),
						endsAt: at("2026-12-21T10:00:00Z"),
					}),
				)
				const feed = yield* schedules.createCalendarFeed(ORG, ADMIN, schedule.id, { replace: false })
				const early = startsOf(Option.getOrThrow(yield* schedules.calendarFeed(feed.token)))
				// Ana's own weeks are an event each, on the handoff, though nobody else is in the rotation.
				assert.includeMembers(early, ["20260921T090000Z", "20260928T090000Z", "20261002T100000Z"])

				// Seven weeks on the override began long before the window: it still starts when it did.
				yield* TestClock.setTime(at("2026-11-20T12:00:00Z"))
				const late = Option.getOrThrow(yield* schedules.calendarFeed(feed.token))
				assert.include(startsOf(late), "20261002T100000Z")
				assert.include(late, "DTEND:20261221T100000Z")
			}).pipe(Effect.provide(makeLayer(testDb)))
		},
	)

	it.effect("fails, and serves no feed without names, when the member directory is down", () => {
		const testDb = createTestDb(createdDbs)
		const directory = { isDown: false }
		const members = stubOrgMembersService([
			{ userId: ana, email: "ana@acme.test", name: "Ana Alves", imageUrl: null },
			{ userId: ben, email: "ben@acme.test", name: "Ben Brook", imageUrl: null },
			{ userId: chen, email: "chen@acme.test", name: null, imageUrl: null },
		])
		const layer = Layer.effect(OnCallSchedulesService, OnCallSchedulesService.make).pipe(
			Layer.provide(
				Layer.merge(
					testDb.layer,
					Layer.succeed(OrgMembersService, {
						...members,
						listMembers: (orgId) =>
							directory.isDown
								? Effect.fail(
										new AlertMemberDirectoryUnavailableError({
											message: "The member directory did not answer",
											cause: "timeout",
										}),
									)
								: members.listMembers(orgId),
					}),
				),
			),
		)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			const feed = yield* schedules.createCalendarFeed(ORG, ADMIN, schedule.id, { replace: false })
			directory.isDown = true
			// Past the directory's minute of cache.
			yield* TestClock.adjust("2 minutes")
			assert.strictEqual(
				errorTag(yield* Effect.exit(schedules.calendarFeed(feed.token))),
				"@maple/http/errors/AlertMemberDirectoryUnavailableError",
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("stores only a hash of the link", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			const feed = yield* schedules.createCalendarFeed(ORG, ADMIN, schedule.id, { replace: false })
			const stored = yield* Effect.promise(() =>
				testDb.pglite.query<{ row: string }>(
					"select row_to_json(s)::text as row from oncall_schedules s where id = $1",
					[schedule.id],
				),
			)
			const row = stored.rows[0]?.row ?? ""
			assert.isAbove(row.length, 0)
			assert.notInclude(row, feed.token)
			assert.notInclude(row, Str.replace("mcal_", "")(feed.token))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("a new link replaces the old one, and turning the feed off ends both", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			const first = yield* schedules.createCalendarFeed(ORG, ADMIN, schedule.id, { replace: false })
			// Without asking to replace, a link in use is left alone.
			assert.strictEqual(
				errorTag(
					yield* Effect.exit(
						schedules.createCalendarFeed(ORG, ADMIN, schedule.id, { replace: false }),
					),
				),
				"@maple/http/errors/OnCallCalendarFeedExistsError",
			)
			assert.isTrue(Option.isSome(yield* schedules.calendarFeed(first.token)))
			const second = yield* schedules.createCalendarFeed(ORG, ADMIN, schedule.id, { replace: true })
			assert.notStrictEqual(first.token, second.token)
			assert.isTrue(Option.isNone(yield* schedules.calendarFeed(first.token)))
			assert.isTrue(Option.isSome(yield* schedules.calendarFeed(second.token)))

			yield* schedules.deleteCalendarFeed(ORG, ADMIN, schedule.id)
			assert.isTrue(Option.isNone(yield* schedules.calendarFeed(second.token)))
			assert.isNull((yield* schedules.get(ORG, schedule.id)).calendarFeedCreatedAt)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("only someone who manages alerts in the schedule's own org can make or end a link", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			assert.strictEqual(
				errorTag(
					yield* Effect.exit(
						schedules.createCalendarFeed(ORG, MEMBER, schedule.id, { replace: false }),
					),
				),
				"@maple/http/errors/AlertForbiddenError",
			)
			assert.strictEqual(
				errorTag(
					yield* Effect.exit(
						schedules.createCalendarFeed(OTHER_ORG, ADMIN, schedule.id, { replace: false }),
					),
				),
				"@maple/http/errors/OnCallScheduleNotFoundError",
			)
			const feed = yield* schedules.createCalendarFeed(ORG, ADMIN, schedule.id, { replace: false })
			assert.strictEqual(
				errorTag(yield* Effect.exit(schedules.deleteCalendarFeed(OTHER_ORG, ADMIN, schedule.id))),
				"@maple/http/errors/OnCallScheduleNotFoundError",
			)
			assert.isTrue(Option.isSome(yield* schedules.calendarFeed(feed.token)))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("a deleted schedule's link opens nothing", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(at("2026-11-10T00:00:00Z"))
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.create(ORG, ana, ADMIN, weekly)
			const feed = yield* schedules.createCalendarFeed(ORG, ADMIN, schedule.id, { replace: false })
			yield* schedules.delete(ORG, ADMIN, schedule.id)
			assert.isTrue(Option.isNone(yield* schedules.calendarFeed(feed.token)))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
