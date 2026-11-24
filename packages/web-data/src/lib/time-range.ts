import { TinybirdDateTime } from "@maple/domain/query-engine"
import {
	formatWarehouseDateTime,
	isCalendarAlignedShorthand,
	parseWarehouseDateTime,
	resolveRelativeRangeToWarehouse,
	snapRangeForCache,
} from "@maple/query-engine"
import { Option, Schema, String as Str } from "effect"

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
	const seconds = parseInt(Str.slice(17, 19)(value), 10)
	if (Number.isNaN(seconds)) return value
	const snapped = seconds - (seconds % CACHE_SNAP_INTERVAL_S)
	return Str.slice(0, 17)(value) + Str.padStart(2, "0")(snapped.toString())
}

export interface ResolveTimeRangeOptions {
	/** The zone day-aligned presets ("today", "7d") start their day in; omitted is `resolveRelativeRangeToWarehouse`'s default. */
	readonly timeZone?: string | undefined
	/** Floor the endpoint to the cache-key grid. Default `true`; `false` after an explicit refresh. */
	readonly snap?: boolean | undefined
}

const isWarehouseDateTime = Schema.is(TinybirdDateTime)

/** A URL bound in the warehouse shape: kept as written, an ISO or other parseable date converted, junk none. */
const toWarehouseBound = (value: string): Option.Option<string> => {
	if (isWarehouseDateTime(value)) return Option.some(value)
	const epochMs = parseWarehouseDateTime(value)
	return Number.isNaN(epochMs) ? Option.none() : Option.some(formatWarehouseDateTime(epochMs))
}

/**
 * The effective window at `nowMs`: an explicit `startTime`/`endTime` pair in the warehouse shape
 * (an ISO pair converted; an unparseable one ignored), otherwise
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
		const explicit = Option.all({
			startTime: toWarehouseBound(startTime),
			endTime: toWarehouseBound(endTime),
		})
		if (Option.isSome(explicit)) return explicit.value
	}
	const resolved =
		resolveRelativeRangeToWarehouse(defaultRange, nowMs, options.timeZone) ??
		resolveRelativeRangeToWarehouse("12h", nowMs, options.timeZone)!
	return options.snap === false
		? resolved
		: snapRangeForCache(resolved, { anchoredStart: isCalendarAlignedShorthand(defaultRange) })
}
