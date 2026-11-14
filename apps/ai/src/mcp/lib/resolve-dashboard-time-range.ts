import { MAX_QUERY_RANGE_SECONDS, resolveTimeRangeWindow, validateRelativeRange } from "@maple/query-engine"

export interface ResolvedTimeRange {
	startTime: string
	endTime: string
}

/**
 * Validates an agent-supplied dashboard `time_range` shorthand.
 *
 * Anything the picker can express is accepted up to the engine's real ceiling;
 * everything else is an explicit error, never a silent fallback to another window.
 *
 * Returns `null` when the value is valid, or an error message to return to the
 * agent when it is not.
 */
export function validateDashboardTimeRange(value: string): string | null {
	const result = validateRelativeRange(value, MAX_QUERY_RANGE_SECONDS)
	return result.ok ? null : (result.error ?? `Invalid time range "${value}".`)
}

export type DashboardTimeRangeInput =
	| { type: "relative"; value: string }
	| { type: "absolute"; startTime: string; endTime: string }

/**
 * Resolves a dashboard `timeRange` (relative shorthand like "24h" or absolute
 * ISO timestamps) into Tinybird's `YYYY-MM-DD HH:mm:ss` UTC format.
 *
 * The shared resolver, unsnapped: an agent inspecting a chart wants the window
 * as of now, not the cache-grid-floored one the browser keys its fetches on.
 * Returns `null` for unrecognized relative shorthands so the caller can fall
 * back to a sensible default window.
 */
export function resolveDashboardTimeRange(timeRange: DashboardTimeRangeInput): ResolvedTimeRange | null {
	return resolveTimeRangeWindow(timeRange, { snap: false })
}
