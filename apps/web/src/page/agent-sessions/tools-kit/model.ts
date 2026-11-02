import { Schema } from "effect"
import type { PresetValue } from "../../kit/time-controls"

// Schemas for the tool analytics reads (`@maple/web-data/lib/tool-analytics` types), shared by
// `/agent-sessions/tools` and the tool detail page.

const measures = {
	calls: Schema.Number,
	sessions: Schema.Number,
	errors: Schema.Number,
	p50: Schema.Number,
	p90: Schema.Number,
	p95: Schema.Number,
}

export const ToolTotals = Schema.Struct(measures)
export type ToolTotals = typeof ToolTotals.Type

export const ToolSeriesPoint = Schema.Struct({ bucket: Schema.Number, seriesKey: Schema.String, ...measures })
export type ToolSeriesPoint = typeof ToolSeriesPoint.Type

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
})
export type ToolBreakdownRow = typeof ToolBreakdownRow.Type

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
})
export type ToolErrorRow = typeof ToolErrorRow.Type

export const ToolMetric = Schema.Literals(["calls", "sessions", "error_rate", "duration"])
export type ToolMetric = typeof ToolMetric.Type
export const ToolPercentile = Schema.Literals(["p50", "p90", "p95"])
export type ToolPercentile = typeof ToolPercentile.Type

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
export const selectedMetric = (search: ToolSearch): ToolMetric => search.metric ?? "calls"
export const selectedPercentile = (search: ToolSearch): ToolPercentile => search.percentile ?? "p90"

/** `toolAnalyticsSelection`: the search as the endpoints take it; a blank box is no filter. */
export const toolSelection = (
	search: ToolSearch,
	window: Readonly<{ startTime: string; endTime: string }>,
) => {
	const needle = (search.q ?? "").trim()
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

/** `chartBucketSeconds` (components/infra/chart-utils.ts): about 100 buckets, 5-minute multiples. */
export const chartBucketSeconds = (startMs: number, endMs: number): number => {
	const windowSeconds = Math.max((endMs - startMs) / 1000, 300)
	return Math.max(300, Math.ceil(windowSeconds / 100 / 300) * 300)
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
