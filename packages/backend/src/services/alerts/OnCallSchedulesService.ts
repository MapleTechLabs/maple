import {
	AlertForbiddenError,
	AlertPersistenceError,
	AlertValidationError,
	IsoDateTimeString,
	MAX_ONCALL_FUTURE_OVERRIDES,
	MAX_ONCALL_OVERRIDE_MS,
	MAX_ONCALL_REPORTED_GAPS,
	MAX_ONCALL_SCHEDULES_PER_ORG,
	ONCALL_GAP_LOOKAHEAD_MS,
	OnCallAtResponse,
	OnCallGap,
	OnCallNow,
	OnCallOverrideDocument,
	OnCallOverrideId as OnCallOverrideIdSchema,
	OnCallOverrideNotFoundError,
	OnCallOverridesListResponse,
	OnCallScheduleDocument,
	OnCallScheduleId as OnCallScheduleIdSchema,
	OnCallCalendarFeedExistsError,
	OnCallScheduleInUseError,
	OnCallScheduleNotFoundError,
	OnCallSchedulesListResponse,
	OnCallShiftDocument,
	OnCallShiftsResponse,
	type AlertMemberDirectoryNotConfiguredError,
	AlertMemberDirectoryUnavailableError,
	type EscalationChainId,
	type OnCallLayers,
	type OnCallOverride,
	type OnCallOverrideCreateRequest,
	type OnCallOverrideId,
	type OnCallScheduleConfig,
	type OnCallScheduleCreateRequest,
	type OnCallScheduleId,
	type OnCallScheduleUpdateRequest,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	EscalationChains,
	AlertEscalationRuns,
	OnCallOverrides,
	OnCallSchedules,
	type OnCallOverrideRow,
	type OnCallScheduleRow,
} from "@maple/db/tables"
import type { MapleDb } from "@maple/db/client"
import {
	MAX_ONCALL_RENDER_RANGE_MS,
	ONCALL_LOOKAROUND_MS,
	absentParticipants,
	onCallAt as resolveOnCallAt,
	renderOnCall,
	uncoveredIntervals,
	type OnCallOptions,
	type OnCallShift,
} from "@maple/alerting-core"
import {
	Array as Arr,
	Cache,
	Context,
	DateTime,
	Duration,
	Effect,
	Layer,
	Option,
	Order,
	Schema,
	String as Str,
} from "effect"
import { createHash, randomBytes } from "node:crypto"
import { renderOnCallCalendar } from "@maple/alerting-core/oncall-ics"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import * as Policy from "@maple/domain/policy"
import { lockOrgAlertRules, makePersistenceError } from "./alert-persistence"
import { AlertRuntime } from "./AlertRuntime"

type MemberLookupError = AlertMemberDirectoryNotConfiguredError | AlertMemberDirectoryUnavailableError
type ScheduleWriteError =
	| AlertForbiddenError
	| AlertValidationError
	| AlertPersistenceError
	| MemberLookupError
type ScheduleReadError = AlertPersistenceError | OnCallScheduleNotFoundError

/** How far ahead the overview draws each schedule, and how far it looks for the caller's own shifts. */
export const ONCALL_OVERVIEW_SCHEDULE_MS = 14 * 24 * 60 * 60_000
export const ONCALL_OVERVIEW_MY_SHIFTS_MS = 60 * 24 * 60 * 60_000
export const MAX_ONCALL_OVERVIEW_MY_SHIFTS = 20

/**
 * A shift inside one of the overview's windows. `continues` says the person is still on call where
 * the shift is cut: the window ended there, nobody took over.
 */
export interface OnCallOverviewShift extends OnCallShift {
	readonly continues: boolean
}

/** One schedule as the overview draws it: who has it, and who covers the days ahead. */
export interface OnCallOverviewSchedule {
	readonly id: OnCallScheduleId
	readonly name: string
	readonly timeZone: string
	readonly layers: OnCallLayers
	/** The stretch that holds now, as far as the caller's window sees it, or null when nobody is on call. */
	readonly now: OnCallOverviewShift | null
	/** Effective shifts over the schedule window, earliest first. The first may have started already. */
	readonly shifts: ReadonlyArray<OnCallOverviewShift>
	readonly gaps: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>
}

/** Everything the phone asks about on-call, in one read. */
export interface OnCallOverview {
	readonly nowMs: number
	readonly scheduleHorizonMs: number
	readonly schedules: ReadonlyArray<OnCallOverviewSchedule>
	/** The caller's own shifts across every schedule, the current one first. */
	readonly myShifts: ReadonlyArray<{
		readonly scheduleId: OnCallScheduleId
		readonly scheduleName: string
		readonly shift: OnCallOverviewShift
	}>
	/** Display names of everyone a shift names; a member without a name is absent. */
	readonly people: ReadonlyArray<{ readonly userId: UserId; readonly name: string }>
}

export interface OnCallSchedulesServiceApi {
	readonly list: (orgId: OrgId) => Effect.Effect<OnCallSchedulesListResponse, AlertPersistenceError>
	/** Who is on call on every schedule, the days ahead, and the caller's own shifts. */
	readonly overview: (orgId: OrgId, userId: UserId) => Effect.Effect<OnCallOverview, AlertPersistenceError>
	readonly get: (
		orgId: OrgId,
		scheduleId: OnCallScheduleId,
	) => Effect.Effect<OnCallScheduleDocument, ScheduleReadError>
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		permissions: Policy.Grants,
		request: OnCallScheduleCreateRequest,
	) => Effect.Effect<OnCallScheduleDocument, ScheduleWriteError>
	readonly update: (
		orgId: OrgId,
		userId: UserId,
		permissions: Policy.Grants,
		scheduleId: OnCallScheduleId,
		request: OnCallScheduleUpdateRequest,
	) => Effect.Effect<OnCallScheduleDocument, ScheduleWriteError | OnCallScheduleNotFoundError>
	/** Deletes the schedule's overrides with it. */
	readonly delete: (
		orgId: OrgId,
		permissions: Policy.Grants,
		scheduleId: OnCallScheduleId,
	) => Effect.Effect<void, AlertForbiddenError | ScheduleReadError | OnCallScheduleInUseError>
	/** Overrides that end after `fromMs` (default now), by start. */
	readonly listOverrides: (
		orgId: OrgId,
		scheduleId: OnCallScheduleId,
		fromMs?: number,
	) => Effect.Effect<OnCallOverridesListResponse, ScheduleReadError>
	readonly createOverride: (
		orgId: OrgId,
		userId: UserId,
		permissions: Policy.Grants,
		scheduleId: OnCallScheduleId,
		request: OnCallOverrideCreateRequest,
	) => Effect.Effect<OnCallOverrideDocument, ScheduleWriteError | OnCallScheduleNotFoundError>
	readonly deleteOverride: (
		orgId: OrgId,
		permissions: Policy.Grants,
		scheduleId: OnCallScheduleId,
		overrideId: OnCallOverrideId,
	) => Effect.Effect<void, AlertForbiddenError | ScheduleReadError | OnCallOverrideNotFoundError>
	readonly onCallAt: (
		orgId: OrgId,
		scheduleId: OnCallScheduleId,
		atMs: number,
	) => Effect.Effect<OnCallAtResponse, ScheduleReadError>
	/** Rendered over [fromMs, toMs), clamped to 90 days. */
	readonly shifts: (
		orgId: OrgId,
		scheduleId: OnCallScheduleId,
		fromMs: number,
		toMs: number,
	) => Effect.Effect<OnCallShiftsResponse, ScheduleReadError | AlertValidationError>
	/** Display names by user id; empty when the member directory cannot be read. */
	readonly memberNames: (orgId: OrgId) => Effect.Effect<ReadonlyMap<string, string>>
	/**
	 * Turns the calendar feed on. The token is returned once and never stored. A feed that already
	 * has a link keeps it unless `replace` is set: replacing ends the link calendars subscribe to.
	 */
	readonly createCalendarFeed: (
		orgId: OrgId,
		permissions: Policy.Grants,
		scheduleId: OnCallScheduleId,
		options: { readonly replace: boolean },
	) => Effect.Effect<
		{ readonly token: string; readonly createdAt: string },
		AlertForbiddenError | ScheduleReadError | OnCallCalendarFeedExistsError
	>
	readonly deleteCalendarFeed: (
		orgId: OrgId,
		permissions: Policy.Grants,
		scheduleId: OnCallScheduleId,
	) => Effect.Effect<void, AlertForbiddenError | ScheduleReadError>
	/** The feed a token opens, as an iCalendar body; none when no schedule holds the token. */
	readonly calendarFeed: (
		token: string,
	) => Effect.Effect<Option.Option<string>, AlertPersistenceError | AlertMemberDirectoryUnavailableError>
}

const validationError = (message: string) => new AlertValidationError({ message, details: [message] })

/** The org's members as one directory read gave them; `ids` null when it could not say who is in. */
interface MemberDirectory {
	readonly ids: MemberIds
	readonly names: ReadonlyMap<string, string>
	/** The directory is configured but did not answer, as opposed to a deployment without one. */
	readonly isUnavailable: boolean
}
const NO_DIRECTORY = { ids: null, names: new Map<string, string>() } as const

const scheduleNotFound = (scheduleId: OnCallScheduleId) =>
	new OnCallScheduleNotFoundError({ message: "On-call schedule not found", scheduleId })

const DAY_MS = 24 * 60 * 60_000
/** What a calendar feed shows: a week back, so a past shift does not vanish, and two months on. */
export const ONCALL_CALENDAR_PAST_MS = 7 * DAY_MS
export const ONCALL_CALENDAR_AHEAD_MS = 60 * DAY_MS
/**
 * Shifts are rendered this far past each end of the feed's window, so one that straddles an end
 * keeps its real start and end (and so its event id) instead of the window's. It is the longest a
 * rotation shift can be; an override can be longer, and the range grows to hold the ones shown.
 */
const ONCALL_CALENDAR_MARGIN_MS = 14 * DAY_MS

/** A shift's event id: stable across fetches, and no schedule or user id can be read off it. */
const calendarShiftUid = (scheduleId: string, shift: { readonly userId: string; readonly startMs: number }) =>
	Str.slice(
		0,
		32,
	)(createHash("sha256").update(`${scheduleId}\n${shift.startMs}\n${shift.userId}`, "utf8").digest("hex"))

export const CALENDAR_FEED_TOKEN_PREFIX = "mcal_"
/** 32 random bytes: the link is the only credential, so it must not be guessable. */
const newCalendarFeedToken = (): string =>
	`${CALENDAR_FEED_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`
/** Only the hash is stored, so a database read does not hand out working links. */
const calendarFeedTokenHash = (token: string): string =>
	createHash("sha256").update(token, "utf8").digest("hex")
/** A cheap shape check before any database read. */
const isCalendarFeedToken = (token: string): boolean =>
	Str.startsWith(CALENDAR_FEED_TOKEN_PREFIX)(token) && token.length <= 128

const decodeScheduleIdSync = Schema.decodeUnknownSync(OnCallScheduleIdSchema)
const decodeOverrideIdSync = Schema.decodeUnknownSync(OnCallOverrideIdSchema)
const decodeIsoSync = Schema.decodeUnknownSync(IsoDateTimeString)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Chains with a step that targets each schedule, from every chain's steps. */
const chainIdsBySchedule = (db: MapleDb, orgId: OrgId) =>
	db
		.run(
			PG.from(EscalationChains)
				.select("id", "stepsJson")
				.where(($) => [$.orgId.eq(orgId)]),
		)
		.pipe(
			Effect.map((rows) => {
				const bySchedule = new Map<string, Array<EscalationChainId>>()
				Arr.forEach(rows, (row) => {
					const scheduleIds = Arr.dedupe(
						Arr.flatMap(row.stepsJson, (step) =>
							Arr.flatMap(step.targets, (target) =>
								target.type === "schedule" ? [target.scheduleId] : [],
							),
						),
					)
					Arr.forEach(scheduleIds, (scheduleId) => {
						bySchedule.set(scheduleId, [...(bySchedule.get(scheduleId) ?? []), row.id])
					})
				})
				return bySchedule
			}),
		)
const iso = (ms: number) => decodeIsoSync(DateTime.formatIso(DateTime.makeUnsafe(ms)))

const configOf = (row: Pick<OnCallScheduleRow, "timeZone" | "layersJson">): OnCallScheduleConfig => ({
	timeZone: row.timeZone,
	layers: row.layersJson,
})

const toOverride = (row: OnCallOverrideRow): OnCallOverride => ({
	id: row.id,
	userId: row.userId,
	startsAt: row.startsAt,
	endsAt: row.endsAt,
	createdAt: row.createdAt,
})

const toShiftDocument = (shift: OnCallShift) =>
	new OnCallShiftDocument({
		userId: shift.userId,
		startsAt: iso(shift.startMs),
		endsAt: iso(shift.endMs),
		source: shift.source,
	})

const toOverrideDocument = (row: OnCallOverrideRow) =>
	new OnCallOverrideDocument({
		id: row.id,
		scheduleId: row.scheduleId,
		userId: row.userId,
		startsAt: iso(row.startsAt),
		endsAt: iso(row.endsAt),
		createdBy: row.createdBy,
		createdAt: iso(row.createdAt),
	})

/** The org's member ids; null when the directory is not configured or could not be read. */
type MemberIds = ReadonlySet<string> | null

/** Everyone counts as present without a directory: nobody is skipped on a guess. */
const presenceOf = (members: MemberIds): OnCallOptions =>
	members === null ? {} : { isPresent: (userId) => members.has(userId) }

const toDocument = (
	row: OnCallScheduleRow,
	overrides: ReadonlyArray<OnCallOverrideRow>,
	nowMs: number,
	chainIds: ReadonlyArray<EscalationChainId>,
	members: MemberIds,
) => {
	const config = configOf(row)
	const shiftOverrides = Arr.map(overrides, toOverride)
	const presence = presenceOf(members)
	const now = resolveOnCallAt(config, shiftOverrides, nowMs, presence)
	const horizonMs = nowMs + ONCALL_GAP_LOOKAHEAD_MS
	const gaps = uncoveredIntervals(
		renderOnCall(config, shiftOverrides, nowMs, horizonMs, presence).final,
		nowMs,
		horizonMs,
	)
	return new OnCallScheduleDocument({
		id: row.id,
		name: row.name,
		description: row.description,
		timeZone: row.timeZone,
		layers: row.layersJson,
		onCallNow:
			now === null
				? null
				: new OnCallNow({ userId: now.userId, startsAt: iso(now.startMs), endsAt: iso(now.endMs) }),
		calendarFeedCreatedAt: row.calendarFeedCreatedAt === null ? null : iso(row.calendarFeedCreatedAt),
		coverageGaps: Arr.map(
			Arr.take(gaps, MAX_ONCALL_REPORTED_GAPS),
			(gap) => new OnCallGap({ startsAt: iso(gap.startMs), endsAt: iso(gap.endMs) }),
		),
		departedUserIds: members === null ? [] : absentParticipants(config, (userId) => members.has(userId)),
		chainIds,
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
	})
}

const participantsOf = (layers: OnCallLayers): ReadonlyArray<UserId> =>
	Arr.dedupe(Arr.flatMap(layers, (layer) => layer.participants))

export class OnCallSchedulesService extends Context.Service<
	OnCallSchedulesService,
	OnCallSchedulesServiceApi
>()("@maple/backend/services/alerts/OnCallSchedulesService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const runtime = yield* AlertRuntime
		const orgMembers = yield* OrgMembersService
		const dbExecute = makeDbExecute(database, "OnCallSchedulesService", makePersistenceError)

		const requireManage = (permissions: Policy.Grants) =>
			Policy.check(
				permissions,
				"oncall:manage",
				(denial) =>
					new AlertForbiddenError({
						message: denial.message,
					}),
			)

		/** Every id must be a current member of the org; unchecked on a deployment with no directory. */
		const requireMembers = (orgId: OrgId, userIds: ReadonlyArray<UserId>) =>
			orgMembers.resolveMembers(orgId, userIds).pipe(
				Effect.asVoid,
				Effect.catchTags({
					"@maple/http/errors/AlertMemberDirectoryNotConfiguredError": () => Effect.void,
					"@maple/http/errors/AlertRecipientSelectionError": (error) =>
						Effect.fail(
							validationError(
								`Not members of this workspace: ${Arr.join(error.unknownUserIds, ", ")}`,
							),
						),
				}),
			)

		const annotate = (scheduleId: OnCallScheduleId) =>
			Effect.annotateCurrentSpan("maple.oncall.schedule_id", scheduleId)

		// Every schedule read asks who is still a member; a minute of staleness spares the directory.
		// An empty list is a directory that could not answer, not an org everyone left.
		const directoryByOrg = yield* Cache.make({
			capacity: 512,
			timeToLive: Duration.minutes(1),
			lookup: (orgId: OrgId) =>
				orgMembers.listMembers(orgId).pipe(
					Effect.map((members): MemberDirectory => ({
						ids:
							members.length === 0
								? null
								: new Set(Arr.map(members, (member) => member.userId)),
						// Names only: an email is never a display name.
						names: new Map(
							Arr.flatMap(members, (m) =>
								m.name === null ? [] : [[m.userId, m.name] as const],
							),
						),
						isUnavailable: false,
					})),
					Effect.catchTags({
						"@maple/http/errors/AlertMemberDirectoryNotConfiguredError": () =>
							Effect.succeed<MemberDirectory>({ ...NO_DIRECTORY, isUnavailable: false }),
						"@maple/http/errors/AlertMemberDirectoryUnavailableError": () =>
							Effect.succeed<MemberDirectory>({ ...NO_DIRECTORY, isUnavailable: true }),
					}),
				),
		})
		const directoryOf = (orgId: OrgId) => Cache.get(directoryByOrg, orgId)
		const memberIdsOf = (orgId: OrgId) => Effect.map(directoryOf(orgId), (directory) => directory.ids)

		const findRow = (db: MapleDb, orgId: OrgId, scheduleId: OnCallScheduleId) =>
			db
				.run(
					PG.from(OnCallSchedules)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.id.eq(scheduleId)])
						.limit(1),
				)
				.pipe(
					Effect.flatMap((rows) =>
						Arr.match(rows, {
							onEmpty: () =>
								Effect.fail(
									new OnCallScheduleNotFoundError({
										message: "On-call schedule not found",
										scheduleId,
									}),
								),
							onNonEmpty: ([row]) => Effect.succeed(row),
						}),
					),
				)

		/** Overrides of the org (or one schedule) that overlap [fromMs, toMs); null `toMs` is open-ended. */
		const overlappingOverrides = (
			db: MapleDb,
			orgId: OrgId,
			fromMs: number,
			toMs: number | null,
			scheduleId?: OnCallScheduleId,
		) =>
			db.run(
				PG.from(OnCallOverrides)
					.select()
					.where(($) => [
						$.orgId.eq(orgId),
						...(scheduleId === undefined ? [] : [$.scheduleId.eq(scheduleId)]),
						$.endsAt.gt(fromMs),
						...(toMs === null ? [] : [$.startsAt.lt(toMs)]),
					])
					.orderBy(["startsAt", "asc"])
					.limit(MAX_ONCALL_FUTURE_OVERRIDES * 2),
			)

		const nowWindow = (nowMs: number) =>
			[nowMs - ONCALL_LOOKAROUND_MS, nowMs + ONCALL_LOOKAROUND_MS] as const

		const list = Effect.fn("OnCallSchedulesService.list")(function* (orgId: OrgId) {
			const nowMs = yield* runtime.now
			const members = yield* memberIdsOf(orgId)
			const [from, to] = nowWindow(nowMs)
			const [rows, nearby, active, chains] = yield* dbExecute((db) =>
				Effect.all(
					[
						db.run(
							PG.from(OnCallSchedules)
								.select()
								.where(($) => [$.orgId.eq(orgId)])
								.orderBy(["name", "asc"])
								.limit(MAX_ONCALL_SCHEDULES_PER_ORG),
						),
						overlappingOverrides(db, orgId, from, to),
						// The org-wide window above is capped, so the overrides that decide who is on
						// call now are read on their own: at most the upcoming cap per schedule.
						db.run(
							PG.from(OnCallOverrides)
								.select()
								.where(($) => [$.orgId.eq(orgId), $.startsAt.lte(nowMs), $.endsAt.gt(nowMs)]),
						),
						chainIdsBySchedule(db, orgId),
					],
					// Four independent reads, so they share the pool instead of queueing.
					{ concurrency: "unbounded" },
				),
			)
			const overrides = Arr.dedupeWith([...active, ...nearby], (a, b) => a.id === b.id)
			yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)
			return new OnCallSchedulesListResponse({
				schedules: Arr.map(rows, (row) =>
					toDocument(
						row,
						Arr.filter(overrides, (o) => o.scheduleId === row.id),
						nowMs,
						chains.get(row.id) ?? [],
						members,
					),
				),
			})
		})

		const overview = Effect.fn("OnCallSchedulesService.overview")(function* (
			orgId: OrgId,
			userId: UserId,
		) {
			const nowMs = yield* runtime.now
			const directory = yield* directoryOf(orgId)
			const scheduleHorizonMs = nowMs + ONCALL_OVERVIEW_SCHEDULE_MS
			const myHorizonMs = nowMs + ONCALL_OVERVIEW_MY_SHIFTS_MS
			const [rows, ahead, active] = yield* dbExecute((db) =>
				Effect.all(
					[
						db.run(
							PG.from(OnCallSchedules)
								.select()
								.where(($) => [$.orgId.eq(orgId)])
								.orderBy(["name", "asc"])
								.limit(MAX_ONCALL_SCHEDULES_PER_ORG),
						),
						overlappingOverrides(db, orgId, nowMs - ONCALL_LOOKAROUND_MS, myHorizonMs),
						// As in `list`: the window read is capped, and the overrides that decide who
						// is on call now must never be the ones the cap drops.
						db.run(
							PG.from(OnCallOverrides)
								.select()
								.where(($) => [$.orgId.eq(orgId), $.startsAt.lte(nowMs), $.endsAt.gt(nowMs)]),
						),
					],
					{ concurrency: "unbounded" },
				),
			)
			const overrides = Arr.dedupeWith([...active, ...ahead], (a, b) => a.id === b.id)
			const presence = presenceOf(directory.ids)
			const rendered = Arr.map(rows, (row) => {
				const config = configOf(row)
				const own = Arr.map(
					Arr.filter(overrides, (o) => o.scheduleId === row.id),
					toOverride,
				)
				// The turn that holds now is only asked for its start: a render begins at its range.
				const turn = resolveOnCallAt(config, own, nowMs, presence)
				// One render for both windows: the schedule's days are the head of the caller's months.
				// Everything below reads this one timeline, so "who is on call now", "who is next" and
				// the days ahead cannot disagree: back-to-back turns of one person are one stretch,
				// and an override that takes over weeks ahead ends the stretch where it starts.
				const final = Arr.map(
					renderOnCall(config, own, nowMs, myHorizonMs, presence).final,
					(shift): OnCallOverviewShift => ({
						...shift,
						startMs:
							turn !== null && shift.startMs === nowMs && shift.userId === turn.userId
								? turn.startMs
								: shift.startMs,
						// Cut by the render, not handed off: past this the read does not know.
						continues: shift.endMs >= myHorizonMs,
					}),
				)
				const shifts = Arr.map(
					Arr.filter(final, (shift) => shift.startMs < scheduleHorizonMs),
					(shift): OnCallOverviewShift => ({
						...shift,
						endMs: Math.min(shift.endMs, scheduleHorizonMs),
						continues: shift.continues || shift.endMs > scheduleHorizonMs,
					}),
				)
				return {
					schedule: {
						id: row.id,
						name: row.name,
						timeZone: row.timeZone,
						layers: row.layersJson,
						now: Option.getOrNull(
							Arr.findFirst(final, (shift) => shift.startMs <= nowMs && shift.endMs > nowMs),
						),
						shifts,
						// Every gap, not the list endpoint's first 20: a schedule that covers two
						// windows a day has more than that in two weeks, and the phone draws them all.
						gaps: uncoveredIntervals(shifts, nowMs, scheduleHorizonMs),
					} satisfies OnCallOverviewSchedule,
					mine: Arr.map(
						Arr.filter(final, (shift) => shift.userId === userId),
						(shift) => ({ scheduleId: row.id, scheduleName: row.name, shift }),
					),
				}
			})
			const schedules = Arr.map(rendered, (one) => one.schedule)
			const myShifts = Arr.take(
				Arr.sort(
					Arr.flatMap(rendered, (one) => one.mine),
					Order.mapInput(
						Order.Number,
						(entry: { readonly shift: OnCallOverviewShift }) => entry.shift.startMs,
					),
				),
				MAX_ONCALL_OVERVIEW_MY_SHIFTS,
			)
			yield* Effect.annotateCurrentSpan({
				orgId,
				"result.rowCount": rows.length,
				"maple.oncall.my_shift_count": myShifts.length,
			})
			const named = Arr.dedupe([
				userId,
				...Arr.flatMap(schedules, (schedule) => [
					...Arr.map(schedule.shifts, (shift) => shift.userId),
					...(schedule.now === null ? [] : [schedule.now.userId]),
				]),
			])
			return {
				nowMs,
				scheduleHorizonMs,
				schedules,
				myShifts,
				people: Arr.flatMap(named, (id) => {
					const name = directory.names.get(id)
					return name === undefined ? [] : [{ userId: id, name }]
				}),
			} satisfies OnCallOverview
		})

		const loadDocument = (
			db: MapleDb,
			orgId: OrgId,
			scheduleId: OnCallScheduleId,
			nowMs: number,
			members: MemberIds,
		) => {
			const [from, to] = nowWindow(nowMs)
			return Effect.all([
				findRow(db, orgId, scheduleId),
				overlappingOverrides(db, orgId, from, to, scheduleId),
				chainIdsBySchedule(db, orgId),
			]).pipe(
				Effect.map(([row, overrides, chains]) =>
					toDocument(row, overrides, nowMs, chains.get(row.id) ?? [], members),
				),
			)
		}

		const get = Effect.fn("OnCallSchedulesService.get")(function* (
			orgId: OrgId,
			scheduleId: OnCallScheduleId,
		) {
			yield* annotate(scheduleId)
			const nowMs = yield* runtime.now
			const members = yield* memberIdsOf(orgId)
			return yield* dbExecute((db) => loadDocument(db, orgId, scheduleId, nowMs, members))
		})

		const create = Effect.fn("OnCallSchedulesService.create")(function* (
			orgId: OrgId,
			userId: UserId,
			permissions: Policy.Grants,
			request: OnCallScheduleCreateRequest,
		) {
			yield* requireManage(permissions)
			yield* requireMembers(orgId, participantsOf(request.layers))
			const nowMs = yield* runtime.now
			const id = decodeScheduleIdSync(runtime.makeUuid())
			yield* annotate(id)
			const row = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* lockOrgAlertRules(db, orgId)
						const existing = yield* db.run(
							PG.from(OnCallSchedules)
								.select("id")
								.where(($) => [$.orgId.eq(orgId)])
								.limit(MAX_ONCALL_SCHEDULES_PER_ORG),
						)
						if (existing.length >= MAX_ONCALL_SCHEDULES_PER_ORG) {
							return yield* validationError(
								`Organizations may have at most ${MAX_ONCALL_SCHEDULES_PER_ORG} on-call schedules`,
							)
						}
						const [inserted] = yield* db.run(
							PG.insertInto(OnCallSchedules)
								.values({
									id,
									orgId,
									name: request.name,
									description: request.description ?? null,
									timeZone: request.timeZone,
									layersJson: request.layers,
									createdAt: nowMs,
									updatedAt: nowMs,
									createdBy: userId,
									updatedBy: userId,
								})
								.returning(),
						)
						return inserted
					}),
				),
			)
			if (row === undefined) {
				return yield* new AlertPersistenceError({ message: "On-call schedule was not created" })
			}
			// Every participant was just checked against the directory, so none has left.
			return toDocument(row, [], nowMs, [], null)
		})

		const update = Effect.fn("OnCallSchedulesService.update")(function* (
			orgId: OrgId,
			userId: UserId,
			permissions: Policy.Grants,
			scheduleId: OnCallScheduleId,
			request: OnCallScheduleUpdateRequest,
		) {
			yield* annotate(scheduleId)
			yield* requireManage(permissions)
			if (request.layers !== undefined) {
				yield* requireMembers(orgId, participantsOf(request.layers))
				// The check above read the directory fresh; the answer must not come from an older read
				// that predates someone it just accepted.
				yield* Cache.invalidate(directoryByOrg, orgId)
			}
			const nowMs = yield* runtime.now
			const members = yield* memberIdsOf(orgId)
			return yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* findRow(db, orgId, scheduleId)
						yield* db.run(
							PG.update(OnCallSchedules)
								.set({
									...(request.name === undefined ? undefined : { name: request.name }),
									...(request.description === undefined
										? undefined
										: { description: request.description }),
									...(request.timeZone === undefined
										? undefined
										: { timeZone: request.timeZone }),
									...(request.layers === undefined
										? undefined
										: { layersJson: request.layers }),
									updatedAt: nowMs,
									updatedBy: userId,
								})
								.where(($) => [$.orgId.eq(orgId), $.id.eq(scheduleId)]),
						)
						return yield* loadDocument(db, orgId, scheduleId, nowMs, members)
					}),
				),
			)
		})

		const remove = Effect.fn("OnCallSchedulesService.delete")(function* (
			orgId: OrgId,
			permissions: Policy.Grants,
			scheduleId: OnCallScheduleId,
		) {
			yield* annotate(scheduleId)
			yield* requireManage(permissions)
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						// Chain writes check their schedules under this lock, so none can start
						// targeting this one between the check and the delete.
						yield* lockOrgAlertRules(db, orgId)
						yield* findRow(db, orgId, scheduleId)
						const chains = yield* db.run(
							PG.from(EscalationChains)
								.select("id", "name")
								.where(($) => [
									$.orgId.eq(orgId),
									PG.sql.cond`${$.stepsJson} @> ${encodeJson([
										{ targets: [{ type: "schedule", scheduleId }] },
									])}::jsonb`,
								]),
						)
						if (chains.length > 0) {
							return yield* new OnCallScheduleInUseError({
								message: `On-call schedule is still paged by escalation chains: ${Arr.join(
									Arr.map(chains, (chain) => chain.name),
									", ",
								)}`,
								scheduleId,
								chainIds: Arr.map(chains, (chain) => chain.id),
								chainNames: Arr.map(chains, (chain) => chain.name),
							})
						}
						// A running escalation pages from its own snapshot, so a chain edited since can still
						// name the schedule until the run ends.
						const naming = yield* db.run(
							PG.from(AlertEscalationRuns)
								.select(
									"chainId",
									"chainName",
									"stepsJson",
									"stepIndex",
									"passIndex",
									"repeatCount",
								)
								.where(($) => [
									$.orgId.eq(orgId),
									$.status.in_("active", "acknowledged"),
									PG.sql.cond`${$.stepsJson} @> ${encodeJson([
										{ targets: [{ type: "schedule", scheduleId }] },
									])}::jsonb`,
								]),
						)
						// Only a step the run can still reach counts: its current one, a later one, or any
						// of them while a repeat is left.
						const runs = Arr.filter(naming, (run) =>
							Arr.some(
								run.stepsJson,
								(step, index) =>
									(index >= run.stepIndex || run.passIndex < run.repeatCount) &&
									Arr.some(
										step.targets,
										(target) =>
											target.type === "schedule" && target.scheduleId === scheduleId,
									),
							),
						)
						if (runs.length > 0) {
							const names = Arr.dedupe(Arr.map(runs, (run) => run.chainName))
							return yield* new OnCallScheduleInUseError({
								message: `On-call schedule is still paged by an escalation on an open incident: ${Arr.join(names, ", ")}`,
								scheduleId,
								chainIds: Arr.dedupe(Arr.map(runs, (run) => run.chainId)),
								chainNames: names,
							})
						}
						// Overrides go with it through the foreign key's cascade.
						yield* db.run(
							PG.deleteFrom(OnCallSchedules).where(($) => [
								$.orgId.eq(orgId),
								$.id.eq(scheduleId),
							]),
						)
					}),
				),
			)
		})

		const listOverrides = Effect.fn("OnCallSchedulesService.listOverrides")(function* (
			orgId: OrgId,
			scheduleId: OnCallScheduleId,
			fromMs?: number,
		) {
			yield* annotate(scheduleId)
			const from = fromMs ?? (yield* runtime.now)
			const rows = yield* dbExecute((db) =>
				Effect.gen(function* () {
					yield* findRow(db, orgId, scheduleId)
					return yield* overlappingOverrides(db, orgId, from, null, scheduleId)
				}),
			)
			return new OnCallOverridesListResponse({ overrides: Arr.map(rows, toOverrideDocument) })
		})

		const createOverride = Effect.fn("OnCallSchedulesService.createOverride")(function* (
			orgId: OrgId,
			userId: UserId,
			permissions: Policy.Grants,
			scheduleId: OnCallScheduleId,
			request: OnCallOverrideCreateRequest,
		) {
			yield* annotate(scheduleId)
			yield* requireManage(permissions)
			const nowMs = yield* runtime.now
			if (request.endsAt <= request.startsAt) {
				return yield* validationError("An override must end after it starts")
			}
			if (request.endsAt - request.startsAt > MAX_ONCALL_OVERRIDE_MS) {
				return yield* validationError("An override may last at most 90 days")
			}
			if (request.endsAt <= nowMs) {
				return yield* validationError("An override must not end in the past")
			}
			yield* requireMembers(orgId, [request.userId])
			const id = decodeOverrideIdSync(runtime.makeUuid())
			const row = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* lockOrgAlertRules(db, orgId)
						yield* findRow(db, orgId, scheduleId)
						const future = yield* db.run(
							PG.from(OnCallOverrides)
								.select("id")
								.where(($) => [
									$.orgId.eq(orgId),
									$.scheduleId.eq(scheduleId),
									$.endsAt.gt(nowMs),
								])
								.limit(MAX_ONCALL_FUTURE_OVERRIDES),
						)
						if (future.length >= MAX_ONCALL_FUTURE_OVERRIDES) {
							return yield* validationError(
								`A schedule may have at most ${MAX_ONCALL_FUTURE_OVERRIDES} upcoming overrides`,
							)
						}
						const [inserted] = yield* db.run(
							PG.insertInto(OnCallOverrides)
								.values({
									id,
									orgId,
									scheduleId,
									userId: request.userId,
									startsAt: request.startsAt,
									endsAt: request.endsAt,
									createdBy: userId,
									createdAt: nowMs,
								})
								.returning(),
						)
						return inserted
					}),
				),
			)
			if (row === undefined) {
				return yield* new AlertPersistenceError({ message: "On-call override was not created" })
			}
			return toOverrideDocument(row)
		})

		const deleteOverride = Effect.fn("OnCallSchedulesService.deleteOverride")(function* (
			orgId: OrgId,
			permissions: Policy.Grants,
			scheduleId: OnCallScheduleId,
			overrideId: OnCallOverrideId,
		) {
			yield* annotate(scheduleId)
			yield* requireManage(permissions)
			yield* dbExecute((db) =>
				Effect.gen(function* () {
					yield* findRow(db, orgId, scheduleId)
					const deleted = yield* db.run(
						PG.deleteFrom(OnCallOverrides)
							.where(($) => [
								$.orgId.eq(orgId),
								$.scheduleId.eq(scheduleId),
								$.id.eq(overrideId),
							])
							.returning("id"),
					)
					if (deleted.length === 0) {
						return yield* new OnCallOverrideNotFoundError({
							message: "On-call override not found",
							overrideId,
						})
					}
				}),
			)
		})

		const onCallAt = Effect.fn("OnCallSchedulesService.onCallAt")(function* (
			orgId: OrgId,
			scheduleId: OnCallScheduleId,
			atMs: number,
		) {
			yield* annotate(scheduleId)
			const [from, to] = nowWindow(atMs)
			const [row, overrides] = yield* dbExecute((db) =>
				Effect.all([
					findRow(db, orgId, scheduleId),
					overlappingOverrides(db, orgId, from, to, scheduleId),
				]),
			)
			const members = yield* memberIdsOf(orgId)
			const shift = resolveOnCallAt(
				configOf(row),
				Arr.map(overrides, toOverride),
				atMs,
				presenceOf(members),
			)
			return new OnCallAtResponse({
				at: iso(atMs),
				shift: shift === null ? null : toShiftDocument(shift),
			})
		})

		const shifts = Effect.fn("OnCallSchedulesService.shifts")(function* (
			orgId: OrgId,
			scheduleId: OnCallScheduleId,
			fromMs: number,
			toMs: number,
		) {
			yield* annotate(scheduleId)
			if (toMs <= fromMs) return yield* validationError("The range must end after it starts")
			const endMs = Math.min(toMs, fromMs + MAX_ONCALL_RENDER_RANGE_MS)
			const [row, overrides] = yield* dbExecute((db) =>
				Effect.all([
					findRow(db, orgId, scheduleId),
					overlappingOverrides(db, orgId, fromMs, endMs, scheduleId),
				]),
			)
			const members = yield* memberIdsOf(orgId)
			const render = renderOnCall(
				configOf(row),
				Arr.map(overrides, toOverride),
				fromMs,
				endMs,
				presenceOf(members),
			)
			return new OnCallShiftsResponse({
				from: iso(fromMs),
				to: iso(endMs),
				layers: Arr.map(render.layers, (layer) => Arr.map(layer, toShiftDocument)),
				final: Arr.map(render.final, toShiftDocument),
			})
		})

		/** Turns the feed on, or with `replace` swaps its link: the old one stops working at once. */
		const createCalendarFeed = Effect.fn("OnCallSchedulesService.createCalendarFeed")(function* (
			orgId: OrgId,
			permissions: Policy.Grants,
			scheduleId: OnCallScheduleId,
			options: { readonly replace: boolean },
		) {
			yield* annotate(scheduleId)
			yield* Effect.annotateCurrentSpan("maple.oncall.calendar_feed_replace", options.replace)
			yield* requireManage(permissions)
			const nowMs = yield* runtime.now
			const token = newCalendarFeedToken()
			const updated = yield* dbExecute((db) =>
				db.run(
					PG.update(OnCallSchedules)
						.set({
							calendarFeedTokenHash: calendarFeedTokenHash(token),
							calendarFeedCreatedAt: nowMs,
						})
						// Decided in the write itself, so two people creating at once cannot both win.
						.where(($) => [
							$.orgId.eq(orgId),
							$.id.eq(scheduleId),
							...(options.replace ? [] : [$.calendarFeedTokenHash.isNull()]),
						])
						.returning("id"),
				),
			)
			if (updated.length === 0) {
				if (options.replace) return yield* scheduleNotFound(scheduleId)
				// Nothing changed: the schedule is gone, or its feed already has a link.
				const existing = yield* dbExecute((db) =>
					db.run(
						PG.from(OnCallSchedules)
							.select("id")
							.where(($) => [$.orgId.eq(orgId), $.id.eq(scheduleId)])
							.limit(1),
					),
				)
				if (existing.length === 0) return yield* scheduleNotFound(scheduleId)
				return yield* new OnCallCalendarFeedExistsError({
					message: "The calendar feed already has a link. Replace it to make a new one.",
					scheduleId,
				})
			}
			return { token, createdAt: iso(nowMs) }
		})

		const deleteCalendarFeed = Effect.fn("OnCallSchedulesService.deleteCalendarFeed")(function* (
			orgId: OrgId,
			permissions: Policy.Grants,
			scheduleId: OnCallScheduleId,
		) {
			yield* annotate(scheduleId)
			yield* requireManage(permissions)
			const updated = yield* dbExecute((db) =>
				db.run(
					PG.update(OnCallSchedules)
						.set({ calendarFeedTokenHash: null, calendarFeedCreatedAt: null })
						.where(($) => [$.orgId.eq(orgId), $.id.eq(scheduleId)])
						.returning("id"),
				),
			)
			if (updated.length === 0) return yield* scheduleNotFound(scheduleId)
		})

		/**
		 * The feed a token opens, as an iCalendar body; none for a token no schedule holds. The token
		 * is the only credential: the request carries no org, so the row names it.
		 */
		const calendarFeed = Effect.fn("OnCallSchedulesService.calendarFeed")(function* (token: string) {
			if (!isCalendarFeedToken(token)) return Option.none<string>()
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(OnCallSchedules)
						.select()
						.where(($) => [$.calendarFeedTokenHash.eq(calendarFeedTokenHash(token))])
						.limit(1)
						.crossTenant(),
				),
			)
			const schedule = rows[0]
			if (schedule === undefined) return Option.none<string>()
			yield* Effect.annotateCurrentSpan({ orgId: schedule.orgId })
			yield* annotate(schedule.id)
			// A directory that is down gives no names and no say on who left: the caller is told to
			// come back, so a calendar app keeps its last good copy instead of a feed of nobody.
			const directory = yield* directoryOf(schedule.orgId)
			if (directory.isUnavailable) {
				return yield* new AlertMemberDirectoryUnavailableError({
					message: "The member directory did not answer",
					cause: "member directory unavailable",
				})
			}
			const nowMs = yield* runtime.now
			// Whole UTC days, so the window's own ends move once a day and not on every fetch.
			const fromMs = Math.floor((nowMs - ONCALL_CALENDAR_PAST_MS) / DAY_MS) * DAY_MS
			const toMs = Math.ceil((nowMs + ONCALL_CALENDAR_AHEAD_MS) / DAY_MS) * DAY_MS
			// Every override that could decide who holds a moment of an override the window shows.
			const overrides = yield* dbExecute((db) =>
				overlappingOverrides(
					db,
					schedule.orgId,
					fromMs - MAX_ONCALL_OVERRIDE_MS,
					toMs + MAX_ONCALL_OVERRIDE_MS,
					schedule.id,
				),
			)
			const shown = Arr.filter(overrides, (row) => row.endsAt > fromMs && row.startsAt < toMs)
			const renderFromMs = Math.max(
				fromMs - MAX_ONCALL_OVERRIDE_MS,
				Math.min(fromMs - ONCALL_CALENDAR_MARGIN_MS, ...Arr.map(shown, (row) => row.startsAt)),
			)
			const renderToMs = Math.min(
				toMs + MAX_ONCALL_OVERRIDE_MS,
				Math.max(toMs + ONCALL_CALENDAR_MARGIN_MS, ...Arr.map(shown, (row) => row.endsAt)),
			)
			const render = renderOnCall(
				configOf(schedule),
				Arr.map(overrides, toOverride),
				renderFromMs,
				renderToMs,
				{ ...presenceOf(directory.ids), rangeLimitMs: renderToMs - renderFromMs },
			)
			return Option.some(
				renderOnCallCalendar({
					scheduleName: schedule.name,
					// One event per handoff, never merged: a rotation of one person is still a
					// shift a week, each with a start that no later fetch moves.
					shifts: Arr.filter(
						render.effective,
						(shift) => shift.endMs > fromMs && shift.startMs < toMs,
					),
					nameOf: (userId) => directory.names.get(userId) ?? null,
					uidOf: (shift) => calendarShiftUid(schedule.id, shift),
					nowMs,
				}),
			)
		})

		const memberNames = Effect.fn("OnCallSchedulesService.memberNames")(function* (orgId: OrgId) {
			const members = yield* orgMembers.listMembers(orgId).pipe(Effect.orElseSucceed(() => []))
			// Names only: an email is never a display name, and an unnamed member shows as their id.
			return new Map(
				Arr.flatMap(members, (m) => (m.name === null ? [] : [[m.userId, m.name] as const])),
			)
		})

		return {
			memberNames,
			createCalendarFeed,
			deleteCalendarFeed,
			calendarFeed,
			list,
			overview,
			get,
			create,
			update,
			delete: remove,
			listOverrides,
			createOverride,
			deleteOverride,
			onCallAt,
			shifts,
		} satisfies OnCallSchedulesServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(OrgMembersService.layer))
}
