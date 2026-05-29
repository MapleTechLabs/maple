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
