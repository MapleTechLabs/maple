import { DashboardRefreshIntervalSeconds, IsoDateTimeString, type TimeRange } from "@maple/domain/http"
import { resolveRelativeRangeToWarehouse } from "@maple/query-engine"
import { Option, Record as Rec, Schema, String as Str } from "effect"

// Cross-widget dashboard controls live in the URL so a view is shareable and
// deep-linkable. Two families share that space:
//
//   `var-<name>`  dashboard-variable selections (Grafana-style)
//   `filter`, `collapsed`, `expanded`, `tab`, `widget`, `refresh`, `range`, `from`, `to`
//                 per-viewer view state: the free-text filter clause, section
//                 collapse overrides, the active tab per section, a tile
//                 deep link, the auto-refresh cadence and the picked time range
//
// This module is the one owner of both. Every `navigate()` on a dashboard route
// rebuilds search from `pickDashboardControlParams`, so a param that is not
// listed here is silently dropped the next time the user toggles edit mode or
// changes a variable. Adding a control param means adding it here first.
export const VARIABLE_PARAM_PREFIX = "var-"

export type VariableSearchParams = Record<`${typeof VARIABLE_PARAM_PREFIX}${string}`, unknown>

export interface DashboardViewParams {
	filter?: string
	collapsed?: string
	expanded?: string
	tab?: string
	widget?: string
	refresh?: number | string
	range?: string
	from?: string
	to?: string
}

export type DashboardControlParams = VariableSearchParams & DashboardViewParams

/**
 * The `var-*` params of a decoded search, prefix stripped and coerced to
 * strings — TanStack JSON-parses values, so `?var-port=8080` arrives as a
 * number. Shared by the dashboard route and the share page, so a `var-` deep
 * link means the same thing on both.
 */
export function variableValuesFromSearch(search: Record<string, unknown>): Record<string, string> {
	const values: Record<string, string> = {}
	for (const [key, value] of Rec.toEntries(search)) {
		if (!Str.startsWith(VARIABLE_PARAM_PREFIX)(key)) continue
		if (typeof value === "string") {
			values[Str.slice(VARIABLE_PARAM_PREFIX.length)(key)] = value
		} else if (typeof value === "number" || typeof value === "boolean") {
			values[Str.slice(VARIABLE_PARAM_PREFIX.length)(key)] = String(value)
		}
	}
	return values
}

const VIEW_PARAM_KEYS = [
	"filter",
	"collapsed",
	"expanded",
	"tab",
	"widget",
	"refresh",
	"range",
	"from",
	"to",
] as const

const decodeIso = Schema.decodeUnknownOption(IsoDateTimeString)

const isPreset = (value: unknown): value is string =>
	typeof value === "string" && resolveRelativeRangeToWarehouse(value, 0, "UTC") !== null

/**
 * This viewer's picked range: `?from=&to=` (both ISO), else `?range=` (a preset the resolver reads).
 * A hand-edited value it cannot read is ignored, so the board's saved range applies instead.
 */
export function timeRangeFromSearch(search: Record<string, unknown>): TimeRange | undefined {
	const bounds = Option.all({ startTime: decodeIso(search.from), endTime: decodeIso(search.to) })
	if (Option.isSome(bounds)) return { type: "absolute", ...bounds.value }
	return isPreset(search.range) ? { type: "relative", value: search.range } : undefined
}

/** The time-range params for a picked range; the other form's params are cleared. */
export function timeRangeParams(timeRange: TimeRange): Pick<DashboardViewParams, "range" | "from" | "to"> {
	return timeRange.type === "relative"
		? { range: timeRange.value, from: undefined, to: undefined }
		: { range: undefined, from: timeRange.startTime, to: timeRange.endTime }
}

/** Ordered cadence options for the picker, straight off the schema's closed set. */
export const REFRESH_INTERVAL_OPTIONS: ReadonlyArray<DashboardRefreshIntervalSeconds> =
	DashboardRefreshIntervalSeconds.literals

const REFRESH_INTERVAL_VALUES = new Set<number>(REFRESH_INTERVAL_OPTIONS)

/** A cadence if the value is a member of the closed set, `undefined` otherwise. */
export function parseRefreshIntervalSeconds(value: unknown): DashboardRefreshIntervalSeconds | undefined {
	// TanStack JSON-parses search values, so `?refresh=30` can arrive as either a
	// number or a string depending on how it was written. An empty `?refresh=` is
	// treated as absent rather than as `Number("") === 0`, which would silently
	// read a truncated URL as "auto-refresh off".
	const seconds =
		typeof value === "number"
			? value
			: typeof value === "string" && Str.trim(value) !== ""
				? Number(value)
				: Number.NaN
	return REFRESH_INTERVAL_VALUES.has(seconds) ? (seconds as DashboardRefreshIntervalSeconds) : undefined
}

/**
 * The cadence this viewer should actually poll at: `?refresh=` wins, then the
 * dashboard's saved default, then off.
 *
 * A hand-edited `?refresh=1` or `?refresh=abc` falls back rather than throwing —
 * same posture as the non-string view params above, and the reason the closed
 * literal set exists at all (nobody gets to ask for a 100ms re-query).
 */
export function resolveRefreshIntervalSeconds(
	param: unknown,
	stored: number | undefined,
): DashboardRefreshIntervalSeconds {
	return parseRefreshIntervalSeconds(param) ?? parseRefreshIntervalSeconds(stored) ?? 0
}

/**
 * Pick every cross-widget control param out of an arbitrary search object.
 *
 * Deliberately excludes `mode`: edit mode is set explicitly by the caller that
 * wants it, so folding it in here would make every navigation sticky in edit.
 *
 * Non-string view params are dropped rather than coerced — `?collapsed=5` is a
 * hand-edit typo, and silently reading it as the section id "5" is worse than
 * ignoring it. `var-*` values keep the looser `unknown` handling they already
 * had, because the variables context coerces them at read time.
 */
export function pickDashboardControlParams(search: Record<string, unknown>): DashboardControlParams {
	const params: Record<string, unknown> = {}

	for (const [key, value] of Rec.toEntries(search)) {
		if (Str.startsWith(VARIABLE_PARAM_PREFIX)(key)) {
			params[key] = value
		}
	}

	for (const key of VIEW_PARAM_KEYS) {
		const value = search[key]
		if (typeof value === "string") {
			params[key] = value
		}
	}

	// `refresh` is the one numeric control param (`?refresh=30`), so the
	// string-only loop above would drop it. An out-of-set number survives the
	// pick and is rejected later by `resolveRefreshIntervalSeconds`, which keeps
	// this function's job to "carry the control params forward".
	if (typeof search.refresh === "number") params.refresh = search.refresh

	return params
}
