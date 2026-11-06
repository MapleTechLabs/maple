import { Array as Arr, DateTime, Option, Schema, String as Str } from "effect"
import { AlertMaintenanceWindowId, IsoDateTimeString, UserId } from "../primitives"
import { HttpTaggedError } from "./error-policy"
import { AlertSilenceMatchers, MAX_ALERT_SILENCE_DURATION_MS } from "./alert-silences"

export const MAX_MAINTENANCE_WINDOW_NAME_LENGTH = 120
export const MAX_MAINTENANCE_WINDOW_REASON_LENGTH = 400
export const MIN_MAINTENANCE_DURATION_MINUTES = 5
export const MAX_MAINTENANCE_DURATION_MINUTES = 7 * 24 * 60
/** How far ahead occurrences are written as silences. */
export const MAINTENANCE_MATERIALIZE_HORIZON_MS = 48 * 60 * 60_000

const DAY_MS = 24 * 60 * 60_000

export const MaintenanceWeekday = Schema.Literals(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]).annotate(
	{
		identifier: "@maple/MaintenanceWeekday",
		title: "Maintenance Weekday",
	},
)
export type MaintenanceWeekday = Schema.Schema.Type<typeof MaintenanceWeekday>

/** `DateTime` parts number weekdays like `Date#getUTCDay`: 0 is Sunday. */
const WEEKDAY_NUMBER = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
} as const satisfies Record<MaintenanceWeekday, number>

export const MaintenanceTimeZone = Schema.String.check(
	Schema.makeFilter(
		(zone: string) =>
			Option.isSome(DateTime.zoneMakeNamed(zone)) || "Expected an IANA time zone such as Europe/Berlin",
	),
).annotate({ identifier: "@maple/MaintenanceTimeZone", title: "Maintenance Time Zone" })

export const MaintenanceStartTime = Schema.String.check(
	Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/, { description: "Expected a 24-hour time as HH:MM" }),
)

export const MaintenanceDurationMinutes = Schema.Int.check(
	Schema.isBetween({
		minimum: MIN_MAINTENANCE_DURATION_MINUTES,
		maximum: MAX_MAINTENANCE_DURATION_MINUTES,
	}),
)

const MaintenanceDays = Schema.Array(MaintenanceWeekday).check(Schema.isMinLength(1), Schema.isUnique())

export const AlertMaintenanceScheduleWeekly = Schema.TaggedStruct("weekly", {
	timeZone: MaintenanceTimeZone,
	days: MaintenanceDays,
	startTime: MaintenanceStartTime,
	durationMinutes: MaintenanceDurationMinutes,
})
export type AlertMaintenanceScheduleWeekly = Schema.Schema.Type<typeof AlertMaintenanceScheduleWeekly>

const checkOnceWindow = (startsAtMs: number, endsAtMs: number): string | true =>
	endsAtMs <= startsAtMs
		? "endsAt must be after startsAt"
		: endsAtMs - startsAtMs > MAX_ALERT_SILENCE_DURATION_MS
			? "A one-off maintenance window can last at most 30 days"
			: true

export const AlertMaintenanceScheduleOnce = Schema.TaggedStruct("once", {
	startsAt: IsoDateTimeString,
	endsAt: IsoDateTimeString,
}).check(
	Schema.makeFilter((window) => checkOnceWindow(Date.parse(window.startsAt), Date.parse(window.endsAt))),
)

/** A window's schedule on the wire and in documents: one-off times are ISO. */
export const AlertMaintenanceSchedule = Schema.Union([
	AlertMaintenanceScheduleOnce,
	AlertMaintenanceScheduleWeekly,
]).annotate({ identifier: "@maple/AlertMaintenanceSchedule", title: "Alert Maintenance Schedule" })
export type AlertMaintenanceSchedule = Schema.Schema.Type<typeof AlertMaintenanceSchedule>

/** The schedule as stored: one-off times are epoch ms. */
export const StoredAlertMaintenanceSchedule = Schema.Union([
	Schema.TaggedStruct("once", { startsAt: Schema.Number, endsAt: Schema.Number }),
	AlertMaintenanceScheduleWeekly,
])
export type StoredAlertMaintenanceSchedule = Schema.Schema.Type<typeof StoredAlertMaintenanceSchedule>

export const toStoredMaintenanceSchedule = (
	schedule: AlertMaintenanceSchedule,
): StoredAlertMaintenanceSchedule =>
	schedule._tag === "once"
		? { _tag: "once", startsAt: Date.parse(schedule.startsAt), endsAt: Date.parse(schedule.endsAt) }
		: schedule

const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)

export const fromStoredMaintenanceSchedule = (
	schedule: StoredAlertMaintenanceSchedule,
): AlertMaintenanceSchedule =>
	schedule._tag === "once"
		? {
				_tag: "once",
				startsAt: decodeIso(new Date(schedule.startsAt).toISOString()),
				endsAt: decodeIso(new Date(schedule.endsAt).toISOString()),
			}
		: schedule

export interface MaintenanceOccurrence {
	readonly startsAtMs: number
	readonly endsAtMs: number
}

const weeklyOccurrences = (
	schedule: AlertMaintenanceScheduleWeekly,
	fromMs: number,
	toMs: number,
): ReadonlyArray<MaintenanceOccurrence> =>
	Option.match(DateTime.zoneMakeNamed(schedule.timeZone), {
		onNone: () => [],
		onSome: (timeZone) => {
			const durationMs = schedule.durationMinutes * 60_000
			const [hour, minute = 0] = Arr.map(Str.split(":")(schedule.startTime), Number)
			const days = new Set<number>(Arr.map(schedule.days, (day) => WEEKDAY_NUMBER[day]))
			// Start a day before the earliest start that could still be running at `fromMs`.
			const first = DateTime.toParts(
				DateTime.makeZonedUnsafe(fromMs - durationMs - DAY_MS, { timeZone }),
			)
			const anchorMs = Date.UTC(first.year, first.month - 1, first.day)
			const dayCount = Math.ceil((toMs - anchorMs) / DAY_MS) + 2
			return Arr.flatMap(Arr.range(0, dayCount), (offset) => {
				// A UTC calendar day stands in for the zone's local date of the same number.
				const date = DateTime.toPartsUtc(DateTime.makeUnsafe(anchorMs + offset * DAY_MS))
				if (!days.has(date.weekDay)) return []
				// "compatible" puts a start in a spring-forward gap at the zone's next valid time.
				const start = DateTime.makeZoned(
					{ year: date.year, month: date.month, day: date.day, hour, minute },
					{ timeZone, adjustForTimeZone: true, disambiguation: "compatible" },
				)
				return Option.match(start, {
					onNone: () => [],
					onSome: (zoned) => {
						const startsAtMs = DateTime.toEpochMillis(zoned)
						const endsAtMs = startsAtMs + durationMs
						return startsAtMs < toMs && endsAtMs > fromMs ? [{ startsAtMs, endsAtMs }] : []
					},
				})
			})
		},
	})

/**
 * Occurrences of `schedule` that overlap [fromMs, toMs), including one that began
 * before `fromMs` and is still running, in start order.
 */
export const maintenanceOccurrences = (
	schedule: StoredAlertMaintenanceSchedule,
	fromMs: number,
	toMs: number,
): ReadonlyArray<MaintenanceOccurrence> => {
	if (toMs <= fromMs) return []
	if (schedule._tag === "weekly") return weeklyOccurrences(schedule, fromMs, toMs)
	return schedule.startsAt < toMs && schedule.endsAt > fromMs
		? [{ startsAtMs: schedule.startsAt, endsAtMs: schedule.endsAt }]
		: []
}

/**
 * Whether a window's matchers cover a (service, environment) series for baseline
 * exclusion. Only services and environments count, and at least one must be named,
 * so a window scoped by rule or tag alone never touches a baseline.
 */
export const maintenanceWindowCoversSeries = (
	matchers: AlertSilenceMatchers,
	serviceName: string,
	environment: string,
): boolean => {
	const services = matchers.services ?? []
	const environments = matchers.environments ?? []
	if (services.length === 0 && environments.length === 0) return false
	return (
		(services.length === 0 || services.includes(serviceName)) &&
		(environments.length === 0 || environments.includes(environment))
	)
}

/** The reason a window's occurrence silences with; kept within a silence reason's limit. */
export const maintenanceSilenceReason = (name: string, reason: string | null): string =>
	Str.slice(0, 500)(reason === null ? `Maintenance: ${name}` : `Maintenance: ${name} (${reason})`)

export const AlertMaintenanceWindowName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isTrimmed(),
	Schema.isMaxLength(MAX_MAINTENANCE_WINDOW_NAME_LENGTH),
)

export const AlertMaintenanceWindowReason = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isTrimmed(),
	Schema.isMaxLength(MAX_MAINTENANCE_WINDOW_REASON_LENGTH),
)

export const AlertMaintenanceOccurrence = Schema.Struct({
	startsAt: IsoDateTimeString,
	endsAt: IsoDateTimeString,
})

export class AlertMaintenanceWindowDocument extends Schema.Class<AlertMaintenanceWindowDocument>(
	"AlertMaintenanceWindowDocument",
)({
	id: AlertMaintenanceWindowId,
	name: Schema.String,
	reason: Schema.NullOr(Schema.String),
	matchers: AlertSilenceMatchers,
	schedule: AlertMaintenanceSchedule,
	excludeFromBaselines: Schema.Boolean,
	enabled: Schema.Boolean,
	/** The occurrence running now, else the next one; null when none is left or the window is disabled. */
	nextOccurrence: Schema.NullOr(AlertMaintenanceOccurrence),
	createdBy: UserId,
	updatedBy: UserId,
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
}) {}

export class AlertMaintenanceWindowsListResponse extends Schema.Class<AlertMaintenanceWindowsListResponse>(
	"AlertMaintenanceWindowsListResponse",
)({
	windows: Schema.Array(AlertMaintenanceWindowDocument),
}) {}

export class AlertMaintenanceWindowCreateRequest extends Schema.Class<AlertMaintenanceWindowCreateRequest>(
	"AlertMaintenanceWindowCreateRequest",
)({
	name: AlertMaintenanceWindowName,
	reason: Schema.optionalKey(Schema.NullOr(AlertMaintenanceWindowReason)),
	matchers: AlertSilenceMatchers,
	schedule: AlertMaintenanceSchedule,
	excludeFromBaselines: Schema.optionalKey(Schema.Boolean),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class AlertMaintenanceWindowUpdateRequest extends Schema.Class<AlertMaintenanceWindowUpdateRequest>(
	"AlertMaintenanceWindowUpdateRequest",
)({
	name: Schema.optionalKey(AlertMaintenanceWindowName),
	reason: Schema.optionalKey(Schema.NullOr(AlertMaintenanceWindowReason)),
	matchers: Schema.optionalKey(AlertSilenceMatchers),
	schedule: Schema.optionalKey(AlertMaintenanceSchedule),
	excludeFromBaselines: Schema.optionalKey(Schema.Boolean),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class AlertMaintenanceWindowNotFoundError extends HttpTaggedError<AlertMaintenanceWindowNotFoundError>()(
	"@maple/http/errors/AlertMaintenanceWindowNotFoundError",
	{ message: Schema.String, maintenanceWindowId: AlertMaintenanceWindowId },
	{
		status: 404,
		code: "alert_maintenance_window_not_found",
		title: "Maintenance window not found",
		message: "No such maintenance window.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}
