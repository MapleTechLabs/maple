import { warehouseDateTimeToIso } from "@maple/query-engine"
import { getBrowserTimeZone, isValidIanaTimeZone } from "@/atoms/timezone-preference-atoms"

type TimezoneFormatInput = string | number | Date

/**
 * Normalize a tz-less warehouse (Tinybird/ClickHouse) DateTime string to an
 * explicit-UTC ISO string. Delegates to the canonical shared helper so web,
 * mobile, and the API all agree on one normalization.
 */
export function normalizeTimestampInput(value: string): string {
	return warehouseDateTimeToIso(value)
}

function toValidDate(input: TimezoneFormatInput): Date | null {
	const normalized = typeof input === "string" ? normalizeTimestampInput(input) : input

	const date = normalized instanceof Date ? normalized : new Date(normalized)
	return Number.isNaN(date.getTime()) ? null : date
}

function resolveTimeZone(timeZone: string): string {
	return isValidIanaTimeZone(timeZone) ? timeZone : getBrowserTimeZone()
}

const timestampFormatters = new Map<string, Intl.DateTimeFormat>()
const timeFormatters = new Map<string, Intl.DateTimeFormat>()
const compactTimeFormatters = new Map<string, Intl.DateTimeFormat>()

export function formatTimestampInTimezone(
	input: TimezoneFormatInput,
	options: { timeZone: string; withMilliseconds?: boolean },
): string {
	const date = toValidDate(input)
	if (!date) return "-"

	const tz = resolveTimeZone(options.timeZone)
	const key = `${tz}|${options.withMilliseconds ? "ms" : ""}`
	let formatter = timestampFormatters.get(key)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			fractionalSecondDigits: options.withMilliseconds ? 3 : undefined,
		})
		timestampFormatters.set(key, formatter)
	}

	return formatter.format(date)
}

export function formatTimeInTimezone(
	input: TimezoneFormatInput,
	options: { timeZone: string; withSeconds?: boolean },
): string {
	const date = toValidDate(input)
	if (!date) return "-"

	const tz = resolveTimeZone(options.timeZone)
	const key = `${tz}|${options.withSeconds ? "s" : ""}`
	let formatter = timeFormatters.get(key)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hour: "2-digit",
			minute: "2-digit",
			second: options.withSeconds ? "2-digit" : undefined,
		})
		timeFormatters.set(key, formatter)
	}

	return formatter.format(date)
}

/** Wall-clock components, interpreted within a specific IANA timezone. */
export interface ZonedWallClock {
	year: number
	month: number // 1-12
	day: number
	hour: number // 0-23
	minute: number
	second: number
}

const zonedPartsFormatters = new Map<string, Intl.DateTimeFormat>()

function zonedPartsFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = zonedPartsFormatters.get(timeZone)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})
		zonedPartsFormatters.set(timeZone, formatter)
	}
	return formatter
}

function extractZonedParts(formatter: Intl.DateTimeFormat, instant: Date): ZonedWallClock {
	const map: Record<string, number> = {}
	for (const part of formatter.formatToParts(instant)) {
		if (part.type !== "literal") map[part.type] = Number(part.value)
	}
	// `h23` reports midnight as hour 24 on some engines; fold it back to 0.
	const hour = map.hour === 24 ? 0 : map.hour
	return { year: map.year, month: map.month, day: map.day, hour, minute: map.minute, second: map.second }
}

/**
 * Offset (in milliseconds) of `timeZone` from UTC at the given instant.
 * Positive when the zone is ahead of UTC (e.g. +2h → 7_200_000).
 */
function timeZoneOffsetMs(instant: Date, timeZone: string): number {
	const parts = extractZonedParts(zonedPartsFormatter(timeZone), instant)
	const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
	return asUtc - instant.getTime()
}

/**
 * Convert a wall-clock time expressed in `timeZone` to the corresponding UTC
 * instant. A single offset-correction pass resolves DST correctly outside the
 * rare ambiguous/skipped hour at a transition boundary.
 */
export function zonedWallClockToUtc(wall: ZonedWallClock, timeZone: string): Date {
	const tz = resolveTimeZone(timeZone)
	const utcGuessMs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
	const offset = timeZoneOffsetMs(new Date(utcGuessMs), tz)
	return new Date(utcGuessMs - offset)
}

/** Decompose a UTC instant into wall-clock components within `timeZone`. */
export function utcToZonedWallClock(instant: Date, timeZone: string): ZonedWallClock {
	const tz = resolveTimeZone(timeZone)
	return extractZonedParts(zonedPartsFormatter(tz), instant)
}

export function formatCompactTimeInTimezone(
	input: TimezoneFormatInput,
	options: { timeZone: string },
): string {
	const date = toValidDate(input)
	if (!date) return "-"

	const tz = resolveTimeZone(options.timeZone)
	let formatter = compactTimeFormatters.get(tz)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-GB", {
			timeZone: tz,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			fractionalSecondDigits: 3,
			hour12: false,
		})
		compactTimeFormatters.set(tz, formatter)
	}

	return formatter.format(date)
}
