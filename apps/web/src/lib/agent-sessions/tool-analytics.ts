// The view model behind `/agent-sessions/tools`, and the pure rules that read
// it: which series the chart draws, which number a metric tile shows, how the
// tail of a long tool list folds into one line, and what the chart is called.
//
// Everything here is a plain function over plain data so the page, the lab and
// the tests all read the same rules. The fetch layer maps the API's rows into
// these shapes (see `api/warehouse/ai-session-tools.ts`); nothing downstream of
// that ever sees a wire shape.

import { AI_TOOLS_BREAKDOWN_MAX } from "@maple/domain/http"
import { formatErrorRate, formatLatency, formatNumber, formatPercent } from "@maple/ui/lib/format"

/** Which measure the strip, the chart and the breakdown columns are reading. */
export const TOOL_METRICS = ["calls", "sessions", "error_rate", "duration"] as const
export type ToolMetric = (typeof TOOL_METRICS)[number]

export const TOOL_PERCENTILES = ["p50", "p90", "p95"] as const
export type ToolPercentile = (typeof TOOL_PERCENTILES)[number]

/**
 * The five numbers every row of this page carries, whatever it is a row of —
 * a bucket, a window total, a tool, a model. Durations are **nanoseconds**,
 * which is what the span table stores; only the formatters convert.
 */
export interface ToolMeasures {
	readonly calls: number
	readonly sessions: number
	readonly errors: number
	readonly p50: number
	readonly p90: number
	readonly p95: number
}

/** One series' value at one bucket. `bucket` is epoch ms. */
export interface ToolSeriesPoint extends ToolMeasures {
	readonly bucket: number
	/** Tool name, model id, or `OTHER_SERIES_KEY` — whatever the series mode splits by. */
	readonly seriesKey: string
}

/** The window's totals. The page fetches one for `current` and one for `previous`. */
export interface ToolTotals extends ToolMeasures {}

/** A ranked row in the Tools table or the Models panel — both are the same shape. */
export interface ToolBreakdownRow extends ToolMeasures {
	/** Tool name or model id. */
	readonly key: string
	/** Epoch ms of the most recent call in this row. */
	readonly lastSeen: number
	/** Epoch ms of the earliest call in this row, bounded by the window. */
	readonly firstSeen: number
}

/* -------------------------------------------------------------------------------------------------
 * The tool detail page's failures
 * -----------------------------------------------------------------------------------------------*/

/** One error type a tool failed with. */
export interface ToolErrorRow {
	/** `''` is a real group: a call that failed naming no type. */
	readonly errorType: string
	readonly message: string
	/** Failed calls with this type. */
	readonly calls: number
	readonly sessions: number
	/** Epoch ms. */
	readonly firstSeen: number
	readonly lastSeen: number
}

/** One session that hit an error type — the modal's left pane. */
export interface ToolErrorSessionRow {
	readonly sessionId: string
	readonly vendorId: string
	readonly agentName: string
	readonly model: string
	readonly hits: number
	/** Epoch ms. */
	readonly lastSeen: number
}

/** One failed call, with what it was called with and what came back. */
export interface ToolErrorOccurrenceRow {
	/** Epoch ms. */
	readonly timestamp: number
	readonly traceId: string
	readonly spanId: string
	readonly sessionId: string
	readonly vendorId: string
	readonly agentName: string
	readonly model: string
	readonly errorType: string
	readonly message: string
	readonly durationNs: number
	readonly statusCode: string
	/** Truncated by the read; `*Bytes` is the true payload size. */
	readonly arguments: string
	readonly argumentsBytes: number
	readonly result: string
	readonly resultBytes: number
}

/** `''` is the failures that named no error type. */
export const UNKNOWN_ERROR_TYPE_LABEL = "unknown"
export const errorTypeLabel = (errorType: string): string =>
	errorType === "" ? UNKNOWN_ERROR_TYPE_LABEL : errorType

export const EMPTY_MEASURES: ToolMeasures = { calls: 0, sessions: 0, errors: 0, p50: 0, p90: 0, p95: 0 }

/* -------------------------------------------------------------------------------------------------
 * Series mode
 * -----------------------------------------------------------------------------------------------*/

/**
 * What the chart splits by, which is decided entirely by how far the scope has
 * been narrowed: no tool means the question is still "which tool", a tool with
 * no model means "which model runs it", and both means there is one line left.
 */
export type ToolSeriesMode = "tools" | "models" | "single"

export function toolSeriesMode(tool: string | undefined, model: string | undefined): ToolSeriesMode {
	if (tool === undefined) return "tools"
	if (model === undefined) return "models"
	return "single"
}

/* -------------------------------------------------------------------------------------------------
 * Reading a metric off a row
 * -----------------------------------------------------------------------------------------------*/

/**
 * The number the selected metric names, off any measures row.
 *
 * `error_rate` is derived rather than stored: the API reports errors and calls,
 * and a rate computed here can never disagree with the two numbers beside it.
 * A row with no calls has no rate — zero would claim "nothing failed", which is
 * a different statement from "nothing ran" — so it reads 0 and the formatters
 * are what decide how that prints.
 */
export function metricValue(
	measures: ToolMeasures,
	metric: ToolMetric,
	percentile: ToolPercentile,
): number {
	switch (metric) {
		case "calls":
			return measures.calls
		case "sessions":
			return measures.sessions
		case "error_rate":
			return measures.calls > 0 ? measures.errors / measures.calls : 0
		case "duration":
			return measures[percentile]
	}
}

/**
 * A count, grouped rather than compacted.
 *
 * `formatNumber` renders 12,480 as "12.5K", which is right for a headline and
 * wrong for a table of call counts that are read against each other — 12.5K and
 * 12.4K are the same number to a reader. Compaction starts at a million, where
 * the exact digits stop being something anyone holds in their head and the
 * lane starts to matter.
 */
export function formatToolCount(value: number): string {
	return Math.abs(value) >= 1_000_000 ? formatNumber(value) : Math.round(value).toLocaleString()
}

/** `errors / calls`, or 0 for a row that never ran. */
export function errorRate(measures: Pick<ToolMeasures, "calls" | "errors">): number {
	return measures.calls > 0 ? measures.errors / measures.calls : 0
}

/** Nanoseconds as a latency string — the warehouse stores ns, `formatLatency` takes ms. */
export function formatDurationNs(ns: number): string {
	if (!Number.isFinite(ns) || ns <= 0) return "—"
	return formatLatency(ns / 1_000_000)
}

/** The metric's value as the tiles, axis and columns print it. */
export function formatToolMetric(value: number, metric: ToolMetric): string {
	switch (metric) {
		case "calls":
		case "sessions":
			return formatToolCount(value)
		case "error_rate":
			return formatErrorRate(value)
		case "duration":
			return formatDurationNs(value)
	}
}

const METRIC_LABEL = {
	calls: "Tool calls",
	sessions: "Sessions",
	error_rate: "Error rate",
	duration: "Duration",
} satisfies Record<ToolMetric, string>

/** Tile eyebrow / chart subject. Duration names the percentile driving it. */
export function toolMetricLabel(metric: ToolMetric, percentile: ToolPercentile): string {
	return metric === "duration" ? `${percentile.toUpperCase()} duration` : METRIC_LABEL[metric]
}

/* -------------------------------------------------------------------------------------------------
 * Deltas
 * -----------------------------------------------------------------------------------------------*/

/** True when a rise in this metric is bad news — every metric here but the
 *  counts. Read only by {@link toolDelta}, which is the one thing that grades a
 *  move on this page. */
const metricRiseIsBad = (metric: ToolMetric): boolean =>
	metric === "error_rate" || metric === "duration"

/* -------------------------------------------------------------------------------------------------
 * Series colours
 * -----------------------------------------------------------------------------------------------*/

/**
 * The series palette, deliberately starting at `--chart-2`.
 *
 * `--chart-1` is the primary — the colour every selection on this page is drawn
 * in (the metric tile's rail, the picked table row, the scope chips). A line
 * wearing it would read as "this series is selected", which is never what it
 * means.
 */
export const TOOL_SERIES_COLOR_TOKENS = ["--chart-2", "--chart-3", "--chart-4", "--chart-5"] as const

/**
 * The folded tail. Grey, because it is a residue rather than a thing.
 *
 * The API folds its own tail first (it returns at most eight keys), so points
 * can already arrive under this key; `foldSeries` merges them into its own tail
 * rather than ranking them as a series, which is what keeps one legend entry.
 */
export const OTHER_SERIES_KEY = "other"

/** `''` is a real breakdown key: a tool call whose tool name, or whose model,
 *  the index could not resolve. It is shown, but it cannot be selected — the
 *  selection contract has no spelling for "the unnamed one". */
export const UNATTRIBUTED_LABEL = "Unattributed"
export const breakdownKeyLabel = (key: string): string => (key === "" ? UNATTRIBUTED_LABEL : key)
export const OTHER_SERIES_COLOR_TOKEN = "--muted-foreground"

/**
 * Key → colour token, assigned in the order given and stable for that order.
 *
 * Callers pass the RANKED key list, so a tool keeps its colour as long as its
 * rank holds; `Other` is always grey wherever it lands.
 */
export function toolSeriesColors(keys: ReadonlyArray<string>): ReadonlyMap<string, string> {
	const out = new Map<string, string>()
	let index = 0
	for (const key of keys) {
		if (key === OTHER_SERIES_KEY) {
			out.set(key, OTHER_SERIES_COLOR_TOKEN)
			continue
		}
		out.set(key, TOOL_SERIES_COLOR_TOKENS[index % TOOL_SERIES_COLOR_TOKENS.length]!)
		index++
	}
	return out
}

/* -------------------------------------------------------------------------------------------------
 * Top-N folding
 * -----------------------------------------------------------------------------------------------*/

/**
 * The series keys in rank order, ranked by **calls** whatever metric is
 * selected.
 *
 * Ranking by the selected metric was the obvious alternative and is worse: the
 * lines would reshuffle their colours every time a tile is clicked, and a
 * once-called tool that happened to fail would out-rank the tool the page is
 * actually about. Volume is the stable answer to "which of these matter".
 */
export function rankSeriesKeys(points: ReadonlyArray<ToolSeriesPoint>): ReadonlyArray<string> {
	const calls = new Map<string, number>()
	for (const point of points) {
		calls.set(point.seriesKey, (calls.get(point.seriesKey) ?? 0) + point.calls)
	}
	return [...calls.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([key]) => key)
}

/* -------------------------------------------------------------------------------------------------
 * Chart title
 * -----------------------------------------------------------------------------------------------*/

/**
 * What the chart is of, read left to right: the measure, then the scope it is
 * measured over. "Error rate · run_tests".
 */
export function toolChartTitle({
	metric,
	percentile,
	tool,
	model,
}: {
	metric: ToolMetric
	percentile: ToolPercentile
	tool?: string
	model?: string
}): string {
	const parts: string[] = [toolMetricLabel(metric, percentile)]
	if (tool !== undefined) parts.push(tool)
	if (model !== undefined) parts.push(model)
	return parts.join(" · ")
}

/**
 * The scope line's count sentence: how much of the window the current selection
 * accounts for, and across how many sessions.
 */
export function scopeSummary(totals: ToolTotals, matchedOfCalls: number, subject?: string): string {
	const sessions = `${formatToolCount(totals.sessions)} session${totals.sessions === 1 ? "" : "s"}`
	// The tool detail page names the tool in its denominator ("of 3,908
	// run_tests calls"), because there the whole page is one tool's and an
	// unqualified "calls" would read as the org's.
	const noun = subject === undefined ? "calls" : `${subject} calls`
	if (matchedOfCalls <= 0 || matchedOfCalls === totals.calls) {
		return `${formatToolCount(totals.calls)} ${noun} · ${sessions}`
	}
	return `${formatToolCount(totals.calls)} of ${formatToolCount(matchedOfCalls)} ${noun} match · ${sessions}`
}

/* -------------------------------------------------------------------------------------------------
 * Sparklines
 * -----------------------------------------------------------------------------------------------*/

/**
 * A sparkline: the selected metric over the window, in bucket order.
 *
 * Takes ONE series — one point per bucket: the scope read with `split: "none"`,
 * or one tool's own points. Series are never merged here, because a bucket's
 * sessions do not add across tools and its percentiles do not average; the
 * merge is the warehouse's.
 */
export function metricSpark(
	points: ReadonlyArray<ToolSeriesPoint>,
	metric: ToolMetric,
	percentile: ToolPercentile,
): ReadonlyArray<number> {
	return points
		.toSorted((a, b) => a.bucket - b.bucket)
		.map((point) => metricValue(point, metric, percentile))
}

/* -------------------------------------------------------------------------------------------------
 * Deltas, in the unit the metric is actually read in
 * -----------------------------------------------------------------------------------------------*/

/** A delta as a tile prints it: the number, and which way it moved. */
export interface ToolDelta {
	readonly text: string
	readonly direction: "up" | "down" | "flat"
	/** True when the move is an improvement — what the colour follows. */
	readonly good: boolean
}

/**
 * The change against the previous window, expressed the way the metric is read.
 *
 * A rate does not move by a percentage — 8% to 16% is "up 8 points", not "up
 * 100%" — and a latency moves by a duration. Only the counts take a percentage,
 * which is why this is not one formatter over `metricDelta`: the number, not
 * just its unit, is different per metric.
 */
export function toolDelta(
	current: ToolMeasures,
	previous: ToolMeasures | undefined,
	metric: ToolMetric,
	percentile: ToolPercentile,
): ToolDelta | null {
	if (previous === undefined) return null
	const before = metricValue(previous, metric, percentile)
	const after = metricValue(current, metric, percentile)
	if (!Number.isFinite(before) || !Number.isFinite(after)) return null

	const direction = (change: number, epsilon: number): ToolDelta["direction"] =>
		Math.abs(change) < epsilon ? "flat" : change > 0 ? "up" : "down"
	const rose = after > before
	const good = metricRiseIsBad(metric) ? !rose : rose

	if (metric === "error_rate") {
		const points = (after - before) * 100
		return { text: `${Math.abs(points).toFixed(1)}pp`, direction: direction(points, 0.05), good }
	}
	if (metric === "duration") {
		const change = after - before
		return {
			// `formatDurationNs` prints zero as "—", which reads as "no reading".
			text: change === 0 ? "0ms" : formatDurationNs(Math.abs(change)),
			// A tenth of a millisecond is not a latency change anyone is reading.
			direction: direction(change, 100_000),
			good,
		}
	}
	// Counts: a percentage, and no percentage at all against a window of zero —
	// "up ∞%" is not a reading.
	if (before === 0) return null
	const change = (after - before) / before
	return { text: formatPercent(Math.abs(change)), direction: direction(change, 0.001), good }
}

/* -------------------------------------------------------------------------------------------------
 * Table badges
 * -----------------------------------------------------------------------------------------------*/

export type ToolBadge = "slowest" | "new"

/** Volume floor a row must clear to be called the slowest, as a share of the
 *  busiest row. A tool called nine times in a week has the slowest p90 in most
 *  windows and is never what the badge is for. */
const SLOWEST_MIN_VOLUME_SHARE = 0.1

/** How far into the window a tool's first call has to land before it reads as
 *  new. Bounded by the window, so this is "new in this range". */
const NEW_AFTER_WINDOW_SHARE = 0.2

/**
 * The one-word annotations the Tools table puts beside a name.
 *
 * `slowest` is the worst P90 among the rows that carry real volume, not the
 * worst P90 outright. `new` is a tool whose first call in the window lands well
 * after the window opened — the honest version of "new" available without a
 * lookback read.
 */
export function toolBadges(
	rows: ReadonlyArray<ToolBreakdownRow>,
	window: { readonly startMs: number; readonly endMs: number },
): ReadonlyMap<string, ToolBadge> {
	const out = new Map<string, ToolBadge>()
	if (rows.length === 0) return out

	const busiest = rows.reduce((max, row) => Math.max(max, row.calls), 0)
	const contenders = rows.filter((row) => row.calls >= busiest * SLOWEST_MIN_VOLUME_SHARE)
	const slowest = contenders.reduce<ToolBreakdownRow | undefined>(
		(worst, row) => (worst === undefined || row.p90 > worst.p90 ? row : worst),
		undefined,
	)
	if (slowest !== undefined && slowest.p90 > 0) out.set(slowest.key, "slowest")

	const span = window.endMs - window.startMs
	if (span > 0) {
		const cutoff = window.startMs + span * NEW_AFTER_WINDOW_SHARE
		for (const row of rows) {
			if (row.firstSeen > cutoff && !out.has(row.key)) out.set(row.key, "new")
		}
	}
	return out
}

/* -------------------------------------------------------------------------------------------------
 * Footers
 * -----------------------------------------------------------------------------------------------*/

/**
 * "Showing all 26 tools · 34,412 calls · 2.4% errors" — the table's own totals,
 * which are the window's before the tool chip narrows it.
 *
 * The read is capped, so a full page is not "all": at the limit the sentence
 * says which rows these are, and the totals beside it are the shown rows' and
 * not the window's.
 */
export function toolsTableFooter(
	rows: ReadonlyArray<ToolBreakdownRow>,
	limit: number = AI_TOOLS_BREAKDOWN_MAX,
): {
	readonly subject: string
	readonly detail: string
} {
	const calls = rows.reduce((sum, row) => sum + row.calls, 0)
	const errors = rows.reduce((sum, row) => sum + row.errors, 0)
	return {
		subject:
			rows.length >= limit
				? `Showing the ${formatToolCount(limit)} busiest tools`
				: `Showing all ${formatToolCount(rows.length)} tool${rows.length === 1 ? "" : "s"}`,
		detail: `· ${formatToolCount(calls)} calls · ${formatErrorRate(calls > 0 ? errors / calls : 0)} errors`,
	}
}
