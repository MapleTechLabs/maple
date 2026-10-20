import {
	isCalendarAlignedShorthand,
	resolveRelativeRangeToWarehouse,
	snapRangeForCache,
} from "@maple/query-engine"

export interface TimeRange {
	startTime: string
	endTime: string
}

const CACHE_SNAP_INTERVAL_S = 15

/**
 * Snap a Tinybird-format datetime string ("YYYY-MM-DD HH:mm:ss") to the
 * nearest floor of CACHE_SNAP_INTERVAL_S seconds for cache key deduplication.
 * Returns the original string unchanged if it doesn't match the format.
 */
export function snapTimestamp(value: string): string {
	if (value.length !== 19 || value[4] !== "-" || value[10] !== " ") return value
	const seconds = parseInt(value.slice(17, 19), 10)
	if (Number.isNaN(seconds)) return value
	const snapped = seconds - (seconds % CACHE_SNAP_INTERVAL_S)
	return value.slice(0, 17) + snapped.toString().padStart(2, "0")
}

export interface ResolveTimeRangeOptions {
	/** The zone day-aligned presets ("today", "7d") start their day in; omitted is `resolveRelativeRangeToWarehouse`'s default. */
	readonly timeZone?: string | undefined
	/** Floor the endpoint to the cache-key grid. Default `true`; `false` after an explicit refresh. */
	readonly snap?: boolean | undefined
}

/**
 * The effective window at `nowMs`: an explicit `startTime`/`endTime` pair untouched, otherwise
 * the `defaultRange` preset (falling back to 12h) resolved and snapped by `snapRangeForCache`.
 * The clock and zone are arguments so every caller (hook, loader, Command) resolves alike.
 */
export function resolveTimeRangeAt(
	nowMs: number,
	startTime: string | undefined,
	endTime: string | undefined,
	defaultRange: string,
	options: ResolveTimeRangeOptions,
): TimeRange {
	if (startTime && endTime) {
		return { startTime, endTime }
	}
	const resolved =
		resolveRelativeRangeToWarehouse(defaultRange, nowMs, options.timeZone) ??
		resolveRelativeRangeToWarehouse("12h", nowMs, options.timeZone)!
	return options.snap === false
		? resolved
		: snapRangeForCache(resolved, { anchoredStart: isCalendarAlignedShorthand(defaultRange) })
}
