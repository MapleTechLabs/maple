// Query time-range limits — single source of truth
//
// These ceilings used to be duplicated as ad-hoc constants across the query
// engine, the MCP tools, and the v2 public API, which drifted: dashboards were
// capped at 7 days by an MCP whitelist while the engine happily served 31, and
// several MCP tools silently clamped results to a week. Everything that bounds
// a time range now reads from here.
//
// Pure — no drivers, no Effect — so this module is safe to re-export from the
// package root barrel and import from the web bundle.
//
// The relative-shorthand *grammar* lives in `./datetime` alongside the rest of
// the date math; this module only decides what is too wide.

import { relativeRangeSeconds } from "./datetime"

/** Widest window any query kind may span. */
export const MAX_QUERY_RANGE_SECONDS = 60 * 60 * 24 * 31

/**
 * List queries (recent traces/logs tiles) scan raw rows rather than a rollup,
 * so they carry a much tighter ceiling than charts.
 */
export const MAX_LIST_RANGE_SECONDS = 60 * 60 * 24 * 7

/** Breakdown queries (pie/bar/heatmap/funnel) aggregate across a whole window. */
export const MAX_BREAKDOWN_RANGE_SECONDS = 60 * 60 * 24 * 30

/**
 * A breakdown with no narrowing filter scans the entire partition prefix, so it
 * gets a far tighter ceiling than a filtered one.
 */
export const MAX_UNFILTERED_BREAKDOWN_RANGE_SECONDS = 60 * 60 * 24

/**
 * Most stored spans a breakdown may read from raw `traces`: ~15s at the ~12M spans/s
 * measured on prod (2026-10-25), against the aggregation profile's 30s limit.
 */
export const MAX_RAW_BREAKDOWN_SPANS = 200_000_000

/** At or under this, even the heaviest org (~31M spans/hour) fits the span budget. */
export const MIN_SPAN_ESTIMATE_RANGE_SECONDS = 60 * 60 * 3

/** Point budget for a single timeseries response. */
export const MAX_TIMESERIES_POINTS = 1_500

/**
 * Endpoints whose result is a raw-row list, and which therefore obey
 * `MAX_LIST_RANGE_SECONDS` rather than the chart ceilings.
 *
 * Lives here rather than beside either consumer because both the browser (which
 * offers a "narrow the range" affordance) and the share resolver (which clamps
 * silently, having no affordance to offer) have to agree on the set. Two copies
 * would drift into a tile that narrows in one surface and scans in the other.
 */
export const LIST_ENDPOINTS: ReadonlySet<string> = new Set([
	"custom_query_builder_list",
	"list_traces",
	"list_logs",
])

/**
 * Attribute/metric discovery reads pre-aggregated hourly rollups, so it can
 * span wider than the raw-row list cap.
 */
export const MAX_DISCOVERY_RANGE_SECONDS = 60 * 60 * 24 * 30

/** Log-pattern mining clusters raw message bodies — expensive, keep it short. */
export const MAX_LOG_PATTERN_RANGE_SECONDS = 60 * 60 * 24

export type QueryRangeKind = "timeseries" | "list" | "breakdown"

/** The ceiling that applies to a given query kind. */
export function maxRangeSecondsForKind(kind: QueryRangeKind): number {
	switch (kind) {
		case "list":
			return MAX_LIST_RANGE_SECONDS
		case "breakdown":
			return MAX_BREAKDOWN_RANGE_SECONDS
		case "timeseries":
			return MAX_QUERY_RANGE_SECONDS
	}
}

export type TimeWindowViolation = "empty" | "too_wide"

/**
 * Why the API refuses a `[startMs, endMs]` window, or `undefined` when it serves
 * it. Shared so clients that derive a window from a response (a trace's own
 * bounds) can be property-tested against the rule the server enforces.
 */
export function timeWindowViolation(
	startMs: number,
	endMs: number,
	maxSeconds: number,
): TimeWindowViolation | undefined {
	if (!(endMs > startMs)) return "empty"
	if ((endMs - startMs) / 1000 > maxSeconds) return "too_wide"
	return undefined
}

const SECONDS_PER_HOUR = 3600
const SECONDS_PER_DAY = SECONDS_PER_HOUR * 24

/**
 * Render a duration as human copy for error messages — "7 days", "24 hours".
 * Keeps every "maximum range is …" string derived from the constants above so
 * changing a limit can never leave stale copy behind.
 */
export function formatRangeSeconds(seconds: number): string {
	if (seconds >= SECONDS_PER_DAY && seconds % SECONDS_PER_DAY === 0) {
		const days = seconds / SECONDS_PER_DAY
		return `${days} day${days === 1 ? "" : "s"}`
	}
	if (seconds >= SECONDS_PER_HOUR && seconds % SECONDS_PER_HOUR === 0) {
		const hours = seconds / SECONDS_PER_HOUR
		return `${hours} hour${hours === 1 ? "" : "s"}`
	}
	const minutes = Math.round(seconds / 60)
	return `${minutes} minute${minutes === 1 ? "" : "s"}`
}

export interface RelativeRangeValidation {
	readonly ok: boolean
	/** Populated when `ok` is false — ready to surface to an agent or a user. */
	readonly error?: string
	/** Parsed duration, present whenever the shorthand was well-formed. */
	readonly seconds?: number
}

/**
 * Validate a relative range shorthand against a ceiling. Returns a structured
 * result rather than throwing so MCP tools can turn it straight into an error
 * response — the point of this whole module is that nothing silently downgrades
 * an out-of-range request any more.
 */
export function validateRelativeRange(
	shorthand: string,
	maxSeconds: number = MAX_QUERY_RANGE_SECONDS,
): RelativeRangeValidation {
	const seconds = relativeRangeSeconds(shorthand)
	if (seconds === null) {
		return {
			ok: false,
			error: `Invalid time range "${shorthand}". Use a relative shorthand like "15m", "6h", "7d", "2w", "3mo", or "today".`,
		}
	}

	if (seconds > maxSeconds) {
		return {
			ok: false,
			seconds,
			error: `Time range "${shorthand}" exceeds the maximum supported range of ${formatRangeSeconds(maxSeconds)}.`,
		}
	}

	return { ok: true, seconds }
}
