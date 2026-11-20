import type { LabelMatcher } from "../ast"

/** A series' label set, `__name__` included. */
export type Labels = Readonly<Record<string, string>>

/**
 * The samples of one series that fall in one bucket `(end - width, end]`, aggregated.
 *
 * The source pre-aggregates samples into buckets aligned with the evaluation
 * windows, so a window is a run of whole buckets and every range function is
 * computed exactly from the buckets it covers. In raw mode each bucket holds one
 * sample (`count` 1, `first*` = `last*`).
 *
 * Times are epoch ms. `resetSum`, `resets` and `changes` count consecutive sample
 * pairs that are both inside this bucket; the evaluator adds the pairs that cross
 * between buckets of the same window.
 */
export interface SampleBucket {
	/** Upper bound (inclusive) of the bucket. */
	readonly end: number
	readonly firstT: number
	readonly firstV: number
	readonly lastT: number
	readonly lastV: number
	/** The sample before the last one, when the bucket holds at least two. */
	readonly prevT: number
	readonly prevV: number
	readonly count: number
	readonly sum: number
	/** Kahan compensation of `sum`; absent (0) when the source sums without one. */
	readonly sumC?: number
	readonly min: number
	readonly max: number
	readonly sumSquares: number
	/** Sum of `prev` over the pairs inside the bucket where `v < prev` (a counter reset). */
	readonly resetSum: number
	readonly resets: number
	readonly changes: number
	/** Regression sums, with t in seconds relative to `SelectorData.timeOriginMs`. */
	readonly sumT: number
	readonly sumTT: number
	readonly sumTV: number
	/** Raw mode only: the sample values in time order (quantile_over_time, smoothing). */
	readonly values?: ReadonlyArray<number>
	/**
	 * The first stale marker after the bucket's last sample and before the series' next sample, if
	 * any (absent or 0: none). Range functions ignore it; an instant selector ends the series there.
	 */
	readonly staleT?: number
}

export interface SeriesData {
	readonly labels: Labels
	/** Non-empty buckets in time order. */
	readonly buckets: ReadonlyArray<SampleBucket>
}

/**
 * What one selector needs from the source.
 *
 * The source returns, for every series the matchers select, its samples in
 * `(startMs, endMs]` aggregated into buckets `(originMs + (k-1)*widthMs, originMs + k*widthMs]`.
 * `widthMs` 0 means raw: one bucket per sample.
 */
export interface SelectorRequest {
	readonly metricName: string | undefined
	readonly matchers: ReadonlyArray<LabelMatcher>
	readonly startMs: number
	readonly endMs: number
	readonly originMs: number
	readonly widthMs: number
	/** Raw mode must also return `values`. */
	readonly needsValues: boolean
	/**
	 * The selector feeds rate, increase or irate: a source storing delta-temporality samples reads
	 * them as a running counter. Elsewhere it returns the deltas as they are, as Prometheus 3 does.
	 */
	readonly accumulateDeltas?: boolean
}

export interface SelectorData {
	readonly series: ReadonlyArray<SeriesData>
	readonly timeOriginMs: number
}

/** One output sample. */
export interface Point {
	readonly t: number
	readonly v: number
}

export interface Sample {
	readonly labels: Labels
	readonly value: number
	/** The sample's own timestamp; `timestamp()` reads it. */
	readonly t: number
}

/** An instant vector: one value per series at one evaluation time. */
export type InstantVector = ReadonlyArray<Sample>

export interface RangeSeries {
	readonly labels: Labels
	readonly points: ReadonlyArray<Point>
}

export type QueryResult =
	| { readonly resultType: "matrix"; readonly result: ReadonlyArray<RangeSeries> }
	| { readonly resultType: "vector"; readonly result: InstantVector }
	| { readonly resultType: "scalar"; readonly result: Point }
	| { readonly resultType: "string"; readonly result: { readonly t: number; readonly v: string } }

export interface EvalLimits {
	/** Series one selector may return before the query fails. */
	readonly maxSeries: number
	/** Points the whole evaluation may hold. */
	readonly maxPoints: number
}

export const DEFAULT_LIMITS: EvalLimits = { maxSeries: 10_000, maxPoints: 5_000_000 }

/** Prometheus' default lookback for instant selectors. */
export const LOOKBACK_MS = 300_000

/** Range functions a source may evaluate itself; `last` is an instant selector's lookback. */
export const PUSHDOWN_FUNCTIONS = [
	"rate",
	"increase",
	"delta",
	"irate",
	"idelta",
	"resets",
	"changes",
	"avg_over_time",
	"sum_over_time",
	"count_over_time",
	"min_over_time",
	"max_over_time",
	"last_over_time",
	"present_over_time",
	"last",
] as const
export type PushdownFunction = (typeof PUSHDOWN_FUNCTIONS)[number]

export const PUSHDOWN_AGGREGATIONS = ["sum", "avg", "min", "max", "count", "group"] as const
export type PushdownAggregation = (typeof PUSHDOWN_AGGREGATIONS)[number]

/**
 * A subtree the source may evaluate whole: `func(selector[range])` at every step,
 * optionally combined `op by (labels)`. Steps are `startMs + j * stepMs`, the
 * window of step j is `(t - offset - range, t - offset]`, and `widthMs` divides
 * both the step and the range so windows are whole buckets.
 */
export interface PushdownRequest {
	readonly metricName: string | undefined
	readonly matchers: ReadonlyArray<LabelMatcher>
	readonly offsetMs: number
	readonly func: PushdownFunction
	readonly rangeMs: number
	readonly startMs: number
	readonly stepMs: number
	readonly steps: number
	readonly widthMs: number
	readonly aggregation: { readonly op: PushdownAggregation; readonly by: ReadonlyArray<string> } | undefined
}

/** A source's answer: per series (or per group), the steps that have a value. */
export interface PushdownData {
	readonly series: ReadonlyArray<{
		readonly labels: Labels
		readonly steps: ReadonlyArray<number>
		readonly values: ReadonlyArray<number>
	}>
}
