// Stored shapes shared by the HTTP contract (`./http/alert-maintenance-windows.ts`) and the Postgres tables.

import { DateTime, Option, Schema } from "effect"

export const MAX_MAINTENANCE_WINDOW_NAME_LENGTH = 120
export const MAX_MAINTENANCE_WINDOW_REASON_LENGTH = 400
export const MIN_MAINTENANCE_DURATION_MINUTES = 5
export const MAX_MAINTENANCE_DURATION_MINUTES = 7 * 24 * 60
/** How far ahead occurrences are written as silences. */
export const MAINTENANCE_MATERIALIZE_HORIZON_MS = 48 * 60 * 60_000

export const MAINTENANCE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const

export const MaintenanceWeekday = Schema.Literals(MAINTENANCE_WEEKDAYS).annotate({
	identifier: "@maple/MaintenanceWeekday",
	title: "Maintenance Weekday",
})
export type MaintenanceWeekday = Schema.Schema.Type<typeof MaintenanceWeekday>

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

/** The schedule as stored: one-off times are epoch ms. */
export const StoredAlertMaintenanceSchedule = Schema.Union([
	Schema.TaggedStruct("once", { startsAt: Schema.Number, endsAt: Schema.Number }),
	AlertMaintenanceScheduleWeekly,
])
export type StoredAlertMaintenanceSchedule = Schema.Schema.Type<typeof StoredAlertMaintenanceSchedule>
