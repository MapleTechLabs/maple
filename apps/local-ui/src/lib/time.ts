// Time helpers for the local query layer and for rendering warehouse timestamps.
//
// The CH query builders accept `startTime` / `endTime` as ClickHouse DateTime
// strings (`'YYYY-MM-DD HH:MM:SS'`, UTC); chDB returns tz-less UTC strings too.
// Everything the user reads is rendered in the browser's local zone.

import { computeBucketSeconds, formatWarehouseDateTime } from "@maple/query-engine"
import { formatRelativeFrom, toEpochMs } from "@maple/ui/lib/time-format"

/** Format an epoch-ms instant as a ClickHouse DateTime string (UTC, second precision). */
export function toClickHouseDateTime(epochMs: number): string {
	return formatWarehouseDateTime(epochMs)
}

export interface TimeBounds {
	startTime: string
	endTime: string
}

// Time-range presets drive the range select in every toolbar.

export interface TimeRange {
	readonly key: string
	readonly label: string
	readonly minutes: number
}

export const TIME_RANGES: ReadonlyArray<TimeRange> = [
	{ key: "1h", label: "1H", minutes: 60 },
	{ key: "6h", label: "6H", minutes: 6 * 60 },
	{ key: "24h", label: "24H", minutes: 24 * 60 },
	{ key: "7d", label: "7D", minutes: 7 * 24 * 60 },
	{ key: "30d", label: "30D", minutes: 30 * 24 * 60 },
]

/** A local store is usually minutes old, so the default window is short enough to chart it. */
export const DEFAULT_RANGE = "1h"

/** The widest preset: what "widen the range" jumps to. */
export const WIDEST_RANGE = "30d"

const MINUTE_MS = 60 * 1000
/** Upper-bound pad so rows stamped slightly ahead (clock skew) or after the anchor still match. */
const END_PAD_MS = 60 * MINUTE_MS

export function isRangeKey(value: string | null | undefined): value is string {
	return TIME_RANGES.some((range) => range.key === value)
}

export function resolveRange(key: string | undefined): TimeRange {
	return TIME_RANGES.find((r) => r.key === key) ?? TIME_RANGES[0]
}

/** Floor an instant to its minute, so anchors taken seconds apart share one query key. */
export function snapToMinute(epochMs: number): number {
	return Math.floor(epochMs / MINUTE_MS) * MINUTE_MS
}

/** Resolve a range key to ClickHouse DateTime bounds, padding the upper bound for clock skew. */
export function boundsForRange(key: string | undefined, anchorMs = Date.now()): TimeBounds {
	const range = resolveRange(key)
	return {
		startTime: toClickHouseDateTime(anchorMs - range.minutes * MINUTE_MS),
		endTime: toClickHouseDateTime(anchorMs + END_PAD_MS),
	}
}

/**
 * Parse a chDB UTC datetime string (tz-less, optional fraction) to epoch-ms.
 * Returns `null` for empty/invalid input or the zero date chDB emits for an
 * empty aggregate.
 */
export function parseClickHouseDateTime(chDateTime: string | null | undefined): number | null {
	if (!chDateTime) return null
	const ms = toEpochMs(chDateTime)
	return Number.isFinite(ms) && ms > 0 ? ms : null
}

/** Compact relative-time label ("3m ago") from a ClickHouse DateTime string. */
export function formatRelativeTime(chDateTime: string | null | undefined): string {
	const ms = parseClickHouseDateTime(chDateTime)
	return ms === null ? "-" : formatRelativeFrom(ms)
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0")

function isSameLocalDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * Local wall-clock time for a warehouse timestamp: `14:05:01.940` today,
 * `Sep 25 14:05:01.940` on other days. `precision: "s"` drops the millis.
 */
export function formatLocalTimestamp(
	chDateTime: string | null | undefined,
	options: { precision?: "ms" | "s"; nowMs?: number } = {},
): string {
	const ms = parseClickHouseDateTime(chDateTime)
	if (ms === null) return "-"
	const date = new Date(ms)
	const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
	const time = options.precision === "s" ? clock : `${clock}.${pad(date.getMilliseconds(), 3)}`
	if (isSameLocalDay(date, new Date(options.nowMs ?? Date.now()))) return time
	const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
	return `${day} ${time}`
}

/** Full local date and time with millis, for detail panels. */
export function formatLocalDateTime(chDateTime: string | null | undefined): string {
	const ms = parseClickHouseDateTime(chDateTime)
	if (ms === null) return "-"
	const date = new Date(ms)
	const day = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
	return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/** The stored value, verbatim and zone-marked, for `title` tooltips and copy. */
export function formatUtcTitle(chDateTime: string | null | undefined): string {
	return chDateTime ? `${chDateTime} UTC` : ""
}

export interface ChartWindow {
	readonly startMs: number
	readonly endMs: number
	readonly bucketSeconds: number
}

/**
 * The span a chart actually draws: the selected range clipped to when data
 * first appeared (a 1h-old store charted at 30D is 59 empty buckets and one
 * point), ending now. Buckets come off the shared ladder, which is aligned
 * with the minutely/hourly rollups so a bucket never straddles two of them.
 */
export function chartWindow(bounds: TimeBounds, firstSeenMs: number | null, nowMs = Date.now()): ChartWindow {
	const rangeStart = toEpochMs(bounds.startTime)
	const endMs = Math.min(toEpochMs(bounds.endTime), nowMs)
	const dataStart = firstSeenMs !== null && firstSeenMs > rangeStart ? firstSeenMs : rangeStart
	// Keep at least ten minutes on screen so a first burst still reads as a line.
	const startMs = Math.min(dataStart, endMs - 10 * MINUTE_MS)
	return {
		startMs,
		endMs,
		bucketSeconds: computeBucketSeconds(startMs, endMs, { targetPoints: 60, minBuckets: 6 }),
	}
}
