// The URL is the whole state of `/agent-sessions/tools`. Every control on the
// page — the metric strip, the percentile columns, the filter toolbar, the two
// breakdown tables — writes a search param and reads it back, so a link carries
// exactly the view someone was looking at and Back undoes one decision at a
// time.
//
// Declared here rather than in the route file because the hook, the page shell
// and the lab all need the decoded shape, and only the route needs the schema.

import { Schema } from "effect"

import { BooleanFromStringParam } from "@/lib/search-params"
import { TOOL_METRICS, TOOL_PERCENTILES } from "./tool-analytics"

const ToolMetricParam = Schema.optional(Schema.Literals(TOOL_METRICS))
const ToolPercentileParam = Schema.optional(Schema.Literals(TOOL_PERCENTILES))
const BooleanParam = Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam]))

/**
 * Spread into the route's own `Schema.Struct`, ahead of `TimeRangeSearchFields`.
 *
 * `Schema.optional` throughout (not `optionalKey`) for the reason the time-range
 * fields give: TanStack Router hands back keys that are present-but-`undefined`,
 * and clearing a filter writes `undefined` explicitly.
 */
export const ToolAnalyticsSearchFields = {
	/** Which measure the strip, chart and tables read. `calls` when absent. */
	metric: ToolMetricParam,
	/** Which percentile drives the Duration tile and the `P…` column. `p90` when absent. */
	percentile: ToolPercentileParam,
	/** The selected tool, exact. Also the scope of the Models panel and the sessions list. */
	tool: Schema.optional(Schema.String),
	/** The selected model, exact. */
	model: Schema.optional(Schema.String),
	/** Tool-name search from the toolbar. */
	q: Schema.optional(Schema.String),
	service: Schema.optional(Schema.String),
	env: Schema.optional(Schema.String),
	/** Restrict to calls that failed. */
	failing: BooleanParam,
}

export const ToolAnalyticsSearch = Schema.Struct(ToolAnalyticsSearchFields)
export type ToolAnalyticsSearch = Schema.Schema.Type<typeof ToolAnalyticsSearch>

export const DEFAULT_TOOL_METRIC = "calls" as const
export const DEFAULT_TOOL_PERCENTILE = "p90" as const

/** The page's default window. Wide enough that a nightly agent shows up at all. */
export const TOOL_ANALYTICS_DEFAULT_PRESET = "7d"

/** The metric actually in force — the param is a hint from a link, absent means the default. */
export const selectedMetric = (search: ToolAnalyticsSearch) => search.metric ?? DEFAULT_TOOL_METRIC

/** The percentile actually in force. */
export const selectedPercentile = (search: ToolAnalyticsSearch) =>
	search.percentile ?? DEFAULT_TOOL_PERCENTILE
