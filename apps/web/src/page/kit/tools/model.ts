import type * as ToolAnalytics from "@maple/web-data/lib/tool-analytics"
import { TOOL_METRICS, TOOL_PERCENTILES } from "@maple/web-data/lib/tool-analytics"
import { Schema, String as Str } from "effect"
import type { PresetValue } from "../time-controls"
import type { RequestMode } from "@maple/views/data/keyed"

// Schemas for the tool analytics reads (`@maple/web-data/lib/tool-analytics` types), shared by
// `/agent-sessions/tools` and the tool detail page. Each is checked against the type it decodes.

const measures = {
	calls: Schema.Number,
	sessions: Schema.Number,
	errors: Schema.Number,
	p50: Schema.Number,
	p90: Schema.Number,
	p95: Schema.Number,
}

export const ToolTotals = Schema.Struct(measures) satisfies Schema.Codec<ToolAnalytics.ToolTotals>
export type ToolTotals = ToolAnalytics.ToolTotals

export const ToolSeriesPoint = Schema.Struct({
	bucket: Schema.Number,
	seriesKey: Schema.String,
	...measures,
}) satisfies Schema.Codec<ToolAnalytics.ToolSeriesPoint>
export type ToolSeriesPoint = ToolAnalytics.ToolSeriesPoint

export const ToolSeries = Schema.Struct({
	data: Schema.Array(ToolSeriesPoint),
	seriesKind: Schema.Literals(["tool", "model", "none"]),
})
export type ToolSeries = typeof ToolSeries.Type

export const ToolBreakdownRow = Schema.Struct({
	key: Schema.String,
	...measures,
	lastSeen: Schema.Number,
	firstSeen: Schema.Number,
}) satisfies Schema.Codec<ToolAnalytics.ToolBreakdownRow>
export type ToolBreakdownRow = ToolAnalytics.ToolBreakdownRow

export const TotalsResult = Schema.Struct({
	current: ToolTotals,
	previous: Schema.UndefinedOr(ToolTotals),
	allSessions: Schema.Number,
	firstSeen: Schema.Number,
	lastSeen: Schema.Number,
	/** The tool's latest `gen_ai.tool.description`, where a call stamped one. */
	description: Schema.UndefinedOr(Schema.String),
})
export type TotalsResult = typeof TotalsResult.Type

/** `ToolErrorRow`: one error group a tool failed with. */
export const ToolErrorRow = Schema.Struct({
	fingerprint: Schema.String,
	errorType: Schema.String,
	message: Schema.String,
	calls: Schema.Number,
	sessions: Schema.Number,
	variants: Schema.Number,
	firstSeen: Schema.Number,
	lastSeen: Schema.Number,
	callsSince: Schema.Number,
	trend: Schema.Array(Schema.Struct({ bucket: Schema.Number, calls: Schema.Number })),
}) satisfies Schema.Codec<ToolAnalytics.ToolErrorRow>
export type ToolErrorRow = ToolAnalytics.ToolErrorRow

export const ToolMetric = Schema.Literals(TOOL_METRICS)
export type ToolMetric = ToolAnalytics.ToolMetric
export const ToolPercentile = Schema.Literals(TOOL_PERCENTILES)
export type ToolPercentile = ToolAnalytics.ToolPercentile

/** The search fields every tools page reads (`ToolAnalyticsSearchFields`). */
export type ToolSearch = Readonly<{
	metric?: ToolMetric
	percentile?: ToolPercentile
	tool?: string
	model?: string
	q?: string
	service?: string
	env?: string
	failing?: boolean
	startTime?: string
	endTime?: string
	timePreset?: string
}>

export const DEFAULT_TOOL_PRESET: PresetValue = "1w"

/** A tools page's resolve args: the URL window, the `1w` default, the viewer's zone. */
export const toolWindowArgs = (search: ToolSearch, timeZone: string, mode: RequestMode) => ({
	mode,
	startTime: search.startTime,
	endTime: search.endTime,
	preset: search.timePreset ?? DEFAULT_TOOL_PRESET,
	timeZone,
})
export const selectedMetric = (search: ToolSearch): ToolMetric => search.metric ?? "calls"
export const selectedPercentile = (search: ToolSearch): ToolPercentile => search.percentile ?? "p90"

/** The search as the endpoints take it; a blank box is no filter. */
export const toolSelection = (
	search: ToolSearch,
	window: Readonly<{ startTime: string; endTime: string }>,
) => {
	const needle = Str.trim(search.q ?? "")
	return {
		startTime: window.startTime,
		endTime: window.endTime,
		tool: search.tool,
		model: search.model,
		service: search.service,
		env: search.env,
		search: needle === "" ? undefined : needle,
		failingOnly: search.failing === true ? true : undefined,
	}
}

/** `toolDetailLinkSearch`: the ambient scope a tool row carries into its page. */
export const toolDetailLinkSearch = (search: ToolSearch) => ({
	model: search.model,
	service: search.service,
	env: search.env,
	failing: search.failing,
	startTime: search.startTime,
	endTime: search.endTime,
	timePreset: search.timePreset,
})
