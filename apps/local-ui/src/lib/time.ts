// Time helpers for the local query layer.
//
// The CH query builders accept `startTime` / `endTime` as ClickHouse DateTime
// strings (`'YYYY-MM-DD HH:MM:SS'`); `resolveParam` quotes them inline. chDB
// parses the quoted string into a DateTime for the partition-pruning filters.

/** Format an epoch-ms instant as a ClickHouse DateTime string (UTC, second precision). */
export function toClickHouseDateTime(epochMs: number): string {
	return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)
}

export interface TimeBounds {
	startTime: string
	endTime: string
}

/**
 * Wide default window for local mode. Data volume is small, so we look back a
 * generous span (default 30 days) and pad the upper bound by an hour to absorb
 * clock skew between the ingesting app and this UI.
 */
export function defaultTimeBounds(days = 30): TimeBounds {
	const now = Date.now()
	return {
		startTime: toClickHouseDateTime(now - days * 24 * 60 * 60 * 1000),
		endTime: toClickHouseDateTime(now + 60 * 60 * 1000),
	}
}

// ---------------------------------------------------------------------------
// Time-range presets — drive the segmented range control in the filter bar.
// ---------------------------------------------------------------------------

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

/** Default look-back. Mirrors the original 30-day window so behavior is unchanged until a user narrows it. */
export const DEFAULT_RANGE = "30d"

/** Resolve a range key to ClickHouse DateTime bounds, padding the upper bound for clock skew. */
export function boundsForRange(key: string | undefined): TimeBounds {
	const range = TIME_RANGES.find((r) => r.key === key) ?? TIME_RANGES[TIME_RANGES.length - 1]
	const now = Date.now()
	return {
		startTime: toClickHouseDateTime(now - range.minutes * 60 * 1000),
		endTime: toClickHouseDateTime(now + 60 * 60 * 1000),
	}
}

/**
 * Compact relative-time label (`12s`, `4m`, `3h`, `2d`) from a ClickHouse
 * DateTime string. chDB emits UTC second-precision strings without a timezone
 * marker, so we append `Z` before parsing.
 */
export function formatRelativeTime(chDateTime: string | null | undefined): string {
	if (!chDateTime) return "—"
	const parsed = Date.parse(`${chDateTime.replace(" ", "T")}Z`)
	if (Number.isNaN(parsed)) return "—"
	const deltaSec = Math.max(0, Math.round((Date.now() - parsed) / 1000))
	if (deltaSec < 60) return `${deltaSec}s ago`
	const min = Math.round(deltaSec / 60)
	if (min < 60) return `${min}m ago`
	const hr = Math.round(min / 60)
	if (hr < 24) return `${hr}h ago`
	const day = Math.round(hr / 24)
	return `${day}d ago`
}
