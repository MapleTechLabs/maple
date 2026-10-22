import { parseClickHouseDateTime, type WarehouseTime } from "../../lib/time"
import { Schema } from "effect"

// lib/time.ts `formatLocalDateTime` / `formatLocalTimestamp` over a locale and zone read once in
// Flags, so the views never read the browser's locale or zone themselves.

/** The browser's default locale and time zone (`Intl.DateTimeFormat().resolvedOptions()`). */
export const TimeFormat = Schema.Struct({ locale: Schema.String, timeZone: Schema.String })
export type TimeFormat = typeof TimeFormat.Type

const pad = (value: number, width = 2) => String(value).padStart(width, "0")

type Clock = Readonly<{ dayKey: string; hours: number; minutes: number; seconds: number }>

/** Wall-clock fields of `ms` in the zone (no zone has a sub-second offset, so millis carry over). */
const clockOf = (format: TimeFormat, ms: number): Clock => {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: format.timeZone,
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
		hourCycle: "h23",
	}).formatToParts(ms)
	const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0)
	return {
		dayKey: `${field("year")}-${field("month")}-${field("day")}`,
		hours: field("hour"),
		minutes: field("minute"),
		seconds: field("second"),
	}
}

const dayLabel = (format: TimeFormat, ms: number, options: Intl.DateTimeFormatOptions) =>
	new Intl.DateTimeFormat(format.locale, { ...options, timeZone: format.timeZone }).format(ms)

const millisOf = (ms: number) => pad(((ms % 1000) + 1000) % 1000, 3)

/** Full local date and time with millis, for detail panels. */
export const formatDateTime = (format: TimeFormat, chDateTime: WarehouseTime): string => {
	const ms = parseClickHouseDateTime(chDateTime)
	if (ms === null) return "-"
	const clock = clockOf(format, ms)
	const day = dayLabel(format, ms, { year: "numeric", month: "short", day: "numeric" })
	return `${day} ${pad(clock.hours)}:${pad(clock.minutes)}:${pad(clock.seconds)}.${millisOf(ms)}`
}

/** `14:05:01.940` today, `Sep 25 14:05:01.940` on other days; `precision: "s"` drops the millis. */
export const formatTimestamp = (
	format: TimeFormat,
	chDateTime: WarehouseTime,
	options: Readonly<{ precision?: "ms" | "s"; nowMs: number }>,
): string => {
	const ms = parseClickHouseDateTime(chDateTime)
	if (ms === null) return "-"
	const clock = clockOf(format, ms)
	const hms = `${pad(clock.hours)}:${pad(clock.minutes)}:${pad(clock.seconds)}`
	const time = options.precision === "s" ? hms : `${hms}.${millisOf(ms)}`
	if (clock.dayKey === clockOf(format, options.nowMs).dayKey) return time
	return `${dayLabel(format, ms, { month: "short", day: "numeric" })} ${time}`
}
