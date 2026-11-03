import type { TimeRange } from "@maple/widgets/dashboard"
import { formatTimestampInTimezone, normalizeTimestampInput } from "@maple/web-data/lib/timezone-format"
import { pluralize } from "@maple/ui/lib/format"
import { DateTime, Option } from "effect"
import { presetLabel } from "../../kit/time-controls"

// `formatTimeRangeDisplay` and `widgetTimeRangeLabel`, with the clock passed in instead of read.

const MINUTE = 60_000
const lastSpan = (count: number, unit: string) => `Last ${count} ${pluralize(count, unit)}`

const epochOf = (value: string): number | null =>
	Option.getOrNull(Option.map(DateTime.make(normalizeTimestampInput(value)), DateTime.toEpochMillis))

/** An absolute window: "Last N units" when it ends now, else both ends in the zone. */
export const timeRangeDisplay = (
	startTime: string,
	endTime: string,
	timeZone: string,
	nowMs: number,
): string => {
	const start = epochOf(startTime)
	const end = epochOf(endTime)
	if (start === null || end === null) return `${startTime} - ${endTime}`
	const diffMs = end - start
	if (Math.abs(end - nowMs) < MINUTE) {
		const minutes = Math.round(diffMs / MINUTE)
		const hours = Math.round(diffMs / (60 * MINUTE))
		const days = Math.round(diffMs / (24 * 60 * MINUTE))
		const weeks = Math.round(diffMs / (7 * 24 * 60 * MINUTE))
		if (minutes < 60) return lastSpan(minutes, "minute")
		if (hours < 24) return lastSpan(hours, "hour")
		if (days < 7) return lastSpan(days, "day")
		if (weeks < 5) return lastSpan(weeks, "week")
		return lastSpan(Math.round(days / 30), "month")
	}
	const format = (epochMs: number) =>
		formatTimestampInTimezone(new Date(epochMs), { timeZone, style: "range" })
	return `${format(start)} - ${format(end)}`
}

/** How a widget's own window reads in its header chip. */
export const widgetTimeRangeLabel = (timeRange: TimeRange, timeZone: string, nowMs: number): string =>
	timeRange.type === "relative"
		? presetLabel(timeRange.value)
		: timeRangeDisplay(timeRange.startTime, timeRange.endTime, timeZone, nowMs)
