/**
 * The window a share is viewed over, and how to describe it.
 *
 * `?from`/`?to` pin an absolute window; `?range=` a relative one; otherwise it
 * is the board's own stored `timeRange`, resolved through the same
 * `resolveTimeRange` the signed-in dashboard seeds its picker from — same
 * relative grammar, same cache-grid snapping, same `"1h"` fallback for a stored
 * preset this build cannot read. The share page used to hardcode "last 12
 * hours" here, which is how a board on "Last 1 hour" shared as a board on twelve.
 */
import { resolveTimeRangeWindow } from "@maple/query-engine"
import { resolveTimeRange } from "@/atoms/dashboard-time-range-atoms"
import { shareTimeRange, type ShareTimeRange } from "@/hooks/use-share-dashboard"
import { formatTimeRangeDisplay, presetLabel } from "@/lib/time-utils"

export interface ShareWindow {
	readonly timeRange: ShareTimeRange
	readonly label: string
}

export interface ShareWindowSearch {
	readonly from?: string
	readonly to?: string
	readonly range?: string
}

const DEFAULT_SHARE_TIME_RANGE = { type: "relative", value: "1h" } as const

export const resolveShareWindow = (
	search: ShareWindowSearch,
	stored: unknown,
	{ snap }: { snap: boolean } = { snap: true },
): ShareWindow | null => {
	if (search.from !== undefined && search.to !== undefined) {
		return {
			timeRange: { startTime: search.from, endTime: search.to },
			label: formatTimeRangeDisplay(search.from, search.to),
		}
	}
	// `resolveTimeRangeWindow`, not `resolveTimeRange`: the latter quietly
	// substitutes "1h" for a shorthand it cannot read, and a typo in the URL
	// should cost the override, not silently show a different window.
	if (search.range !== undefined) {
		const range = resolveTimeRangeWindow({ type: "relative", value: search.range }, { snap })
		if (range !== null) return { timeRange: range, label: presetLabel(search.range) }
	}
	const timeRange = shareTimeRange(stored) ?? DEFAULT_SHARE_TIME_RANGE
	const resolved = resolveTimeRange(timeRange, { snap })
	if (resolved === null) return null
	return {
		timeRange: resolved,
		label:
			timeRange.type === "relative"
				? presetLabel(timeRange.value)
				: formatTimeRangeDisplay(resolved.startTime, resolved.endTime),
	}
}
