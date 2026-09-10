// The view model behind `/agent-sessions/tools`, and the pure rules that read
// it: which series the chart draws, which number a metric tile shows, how the
// tail of a long tool list folds into one line, and what the chart is called.
//
// Everything here is a plain function over plain data so the page, the lab and
// the tests all read the same rules. The fetch layer maps the API's rows into
// these shapes (see `api/warehouse/ai-session-tools.ts`); nothing downstream of
// that ever sees a wire shape.

import { formatErrorRate, formatLatency, formatNumber } from "@maple/ui/lib/format"

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
}

/** A session that called the current selection. */
export interface ToolSessionRow {
	readonly sessionId: string
	readonly agentName: string
	readonly model: string
	readonly serviceName: string
	readonly calls: number
	readonly errors: number
	readonly avgDurationNs: number
	readonly maxDurationNs: number
	/** Epoch ms. */
	readonly startedAt: number
}

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
			return formatNumber(value)
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

/**
 * Fractional change against the previous window, or `null` when there is
 * nothing to compare against.
 *
 * A previous window of zero has no percentage — "up ∞%" is not a reading — and
 * an absent previous window (its query is still in flight, or failed) drops the
 * delta rather than the number it sits beside.
 */
export function metricDelta(
	current: ToolMeasures,
	previous: ToolMeasures | undefined,
	metric: ToolMetric,
	percentile: ToolPercentile,
): number | null {
	if (previous === undefined) return null
	const before = metricValue(previous, metric, percentile)
	if (!Number.isFinite(before) || before === 0) return null
	const after = metricValue(current, metric, percentile)
	if (!Number.isFinite(after)) return null
	return (after - before) / before
}

/** True when a rise in this metric is bad news — every metric here but the counts. */
export function metricRiseIsBad(metric: ToolMetric): boolean {
	return metric === "error_rate" || metric === "duration"
}

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
export const OTHER_SERIES_KEY = "Other"
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

/** How many named lines the chart draws before the rest fold into `Other`. */
export const TOOL_SERIES_LIMIT = 4

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

/**
 * Keep the top `limit` series and fold everything else into one `Other` line.
 *
 * Counts add. Percentiles do not — there is no way to combine two p90s into the
 * p90 of their union — so `Other`'s percentiles are the **call-weighted mean**
 * of its members', which is an approximation and is labelled as one in the
 * tooltip. It is the honest shape of the compromise: the alternative is either
 * dropping the tail (a chart that hides work) or a percentile of percentiles
 * presented as fact.
 *
 * Returns the folded points and the ranked key list the chart draws in order.
 */
export function foldSeries(
	points: ReadonlyArray<ToolSeriesPoint>,
	limit: number = TOOL_SERIES_LIMIT,
): { points: ReadonlyArray<ToolSeriesPoint>; keys: ReadonlyArray<string> } {
	// `Other` never competes for a slot: the API's own tail and this one are the
	// same residue, and ranking them apart would draw two grey lines.
	const ranked = rankSeriesKeys(points).filter((key) => key !== OTHER_SERIES_KEY)
	const apiFolded = points.some((point) => point.seriesKey === OTHER_SERIES_KEY)
	if (ranked.length <= limit && !apiFolded) return { points, keys: ranked }

	const kept = new Set(ranked.slice(0, limit))
	const passthrough: ToolSeriesPoint[] = []
	// Bucket → the tail's running sums, plus the call-weighted percentile sums.
	const folded = new Map<number, { measures: ToolMeasures; weighted: { p50: number; p90: number; p95: number } }>()

	for (const point of points) {
		if (kept.has(point.seriesKey)) {
			passthrough.push(point)
			continue
		}
		const entry = folded.get(point.bucket) ?? {
			measures: { ...EMPTY_MEASURES },
			weighted: { p50: 0, p90: 0, p95: 0 },
		}
		folded.set(point.bucket, {
			measures: {
				calls: entry.measures.calls + point.calls,
				sessions: entry.measures.sessions + point.sessions,
				errors: entry.measures.errors + point.errors,
				p50: 0,
				p90: 0,
				p95: 0,
			},
			weighted: {
				p50: entry.weighted.p50 + point.p50 * point.calls,
				p90: entry.weighted.p90 + point.p90 * point.calls,
				p95: entry.weighted.p95 + point.p95 * point.calls,
			},
		})
	}

	const otherPoints: ToolSeriesPoint[] = [...folded.entries()].map(([bucket, entry]) => {
		const weight = entry.measures.calls
		return {
			bucket,
			seriesKey: OTHER_SERIES_KEY,
			...entry.measures,
			p50: weight > 0 ? entry.weighted.p50 / weight : 0,
			p90: weight > 0 ? entry.weighted.p90 / weight : 0,
			p95: weight > 0 ? entry.weighted.p95 / weight : 0,
		}
	})

	return {
		points: [...passthrough, ...otherPoints],
		keys: [...ranked.slice(0, limit), OTHER_SERIES_KEY],
	}
}

/* -------------------------------------------------------------------------------------------------
 * Chart title
 * -----------------------------------------------------------------------------------------------*/

/**
 * What the chart is of, read left to right: the measure, then the scope it is
 * measured over, then what it is split by.
 *
 * "Error rate · run_tests · by model". The split is dropped for a single line —
 * there is nothing to be "by".
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
	const mode = toolSeriesMode(tool, model)
	if (mode === "tools") parts.push("by tool")
	if (mode === "models") parts.push("by model")
	return parts.join(" · ")
}

/**
 * The scope line's count sentence: how much of the window the current selection
 * accounts for, and across how many sessions.
 */
export function scopeSummary(totals: ToolTotals, matchedOfCalls: number): string {
	const sessions = `${formatNumber(totals.sessions)} session${totals.sessions === 1 ? "" : "s"}`
	if (matchedOfCalls <= 0 || matchedOfCalls === totals.calls) {
		return `${formatNumber(totals.calls)} calls · ${sessions}`
	}
	return `${formatNumber(totals.calls)} of ${formatNumber(matchedOfCalls)} calls match · ${sessions}`
}

/* -------------------------------------------------------------------------------------------------
 * Sparklines
 * -----------------------------------------------------------------------------------------------*/

/**
 * The whole scope per bucket, whatever it is split into — every series added
 * back together.
 *
 * Counts add; percentiles are call-weighted for the same reason `foldSeries`
 * weights them, and with the same caveat. A tile's sparkline is a shape, not a
 * readout: it says "this rose through Tuesday", and the number above it is the
 * measured one.
 */
export function aggregateByBucket(
	points: ReadonlyArray<ToolSeriesPoint>,
): ReadonlyArray<{ bucket: number } & ToolMeasures> {
	const byBucket = new Map<number, { measures: ToolMeasures; weighted: { p50: number; p90: number; p95: number } }>()
	for (const point of points) {
		const entry = byBucket.get(point.bucket) ?? {
			measures: { ...EMPTY_MEASURES },
			weighted: { p50: 0, p90: 0, p95: 0 },
		}
		byBucket.set(point.bucket, {
			measures: {
				calls: entry.measures.calls + point.calls,
				sessions: entry.measures.sessions + point.sessions,
				errors: entry.measures.errors + point.errors,
				p50: 0,
				p90: 0,
				p95: 0,
			},
			weighted: {
				p50: entry.weighted.p50 + point.p50 * point.calls,
				p90: entry.weighted.p90 + point.p90 * point.calls,
				p95: entry.weighted.p95 + point.p95 * point.calls,
			},
		})
	}
	return [...byBucket.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([bucket, entry]) => {
			const weight = entry.measures.calls
			return {
				bucket,
				...entry.measures,
				p50: weight > 0 ? entry.weighted.p50 / weight : 0,
				p90: weight > 0 ? entry.weighted.p90 / weight : 0,
				p95: weight > 0 ? entry.weighted.p95 / weight : 0,
			}
		})
}

/** A tile's sparkline: the selected metric over the window, in bucket order. */
export function metricSpark(
	points: ReadonlyArray<ToolSeriesPoint>,
	metric: ToolMetric,
	percentile: ToolPercentile,
): ReadonlyArray<number> {
	return aggregateByBucket(points).map((bucket) => metricValue(bucket, metric, percentile))
}
