import { findFirstPartialIndex, trimEmptyTrailingBuckets } from "@maple/ui/components/plot/partial-buckets"
import { bucketIntervalLabel, inferBucketSeconds, inferRangeMs, parseBucketMs } from "@maple/ui/lib/format"

// copied: the React-free halves of `useFixedMetricModel` (packages/ui/src/components/plot/fixed-metrics.tsx)
// No `@tanstack/charts` import: views read this too.

import { rowsDomainMs, type TimeseriesAxisContext, type TimeseriesRow } from "./timeseries-rows"

/** `normaliseFixedRows`: rows with their bucket parsed; a row with no parseable bucket is dropped. */
export const normaliseFixedRows = (data: ReadonlyArray<Record<string, unknown>>): Array<TimeseriesRow> =>
	data.flatMap((row) => {
		const bucket = typeof row.bucket === "string" ? row.bucket : ""
		const epochMs = parseBucketMs(bucket)
		return epochMs == null ? [] : [{ ...row, bucket, date: new Date(epochMs) }]
	})

/** `reportedNothingPredicate`: a bucket with `totalCount === 0` reported nothing. */
const reportedNothingPredicate = (
	rows: ReadonlyArray<TimeseriesRow>,
): ((row: TimeseriesRow) => boolean) | undefined =>
	rows.some((row) => typeof row.totalCount === "number")
		? (row) => (typeof row.totalCount === "number" ? row.totalCount === 0 : true)
		: undefined

export interface FixedMetricModel {
	readonly rows: ReadonlyArray<TimeseriesRow>
	readonly plotRows: ReadonlyArray<TimeseriesRow>
	readonly trimOptions: { isEmpty?: (row: TimeseriesRow) => boolean; now: number }
	readonly bucketSeconds: number | undefined
	readonly axisContext: TimeseriesAxisContext
}

/** `useFixedMetricModel` without the hooks; `nowMs` stands in for the render-time `Date.now()`. */
export const fixedMetricModel = (
	data: ReadonlyArray<Record<string, unknown>>,
	timeZone: string | null,
	nowMs: number,
): FixedMetricModel => {
	const rows = normaliseFixedRows(data)
	const isEmpty = reportedNothingPredicate(rows)
	const trimOptions = isEmpty === undefined ? { now: nowMs } : { isEmpty, now: nowMs }
	const first = findFirstPartialIndex(rows, { now: nowMs })
	const plotRows =
		first === -1 || isEmpty === undefined ? rows : trimEmptyTrailingBuckets(rows, [], first, trimOptions)
	const bucketSeconds = inferBucketSeconds(plotRows)
	return {
		rows,
		plotRows,
		trimOptions,
		bucketSeconds,
		axisContext: {
			rangeMs: inferRangeMs(plotRows),
			bucketSeconds,
			domainMs: rowsDomainMs(plotRows),
			timeZone: timeZone ?? undefined,
		},
	}
}

/** One fixed series, as the marks, tooltip and legend all see it (`FixedMetricSeries`). */
export interface FixedMetricSeries {
	readonly key: string
	readonly label: string
	readonly color: string
	readonly dashed?: boolean
}

// copied: `ThroughputAreaChart`'s keys and `deriveRows` (throughput-area-chart.tsx).
export const THROUGHPUT_KEY = "throughput"
export const ERROR_KEY = "errorThroughput"
export const TRACED_KEY = "tracedThroughput"

export const deriveThroughputRows = (
	rows: ReadonlyArray<TimeseriesRow>,
	divisor: number,
): Array<TimeseriesRow> =>
	rows.map((row) => {
		const errorRate = typeof row.errorRate === "number" ? row.errorRate : 0
		const rawThroughput = row[THROUGHPUT_KEY]
		const rawTraced = row[TRACED_KEY]
		const throughput = typeof rawThroughput === "number" ? rawThroughput / divisor : null
		const traced = typeof rawTraced === "number" ? rawTraced / divisor : null
		return {
			...row,
			[THROUGHPUT_KEY]: throughput,
			[TRACED_KEY]: traced,
			[ERROR_KEY]: throughput == null ? null : throughput * errorRate,
		}
	})

export interface ThroughputPlot {
	readonly rows: ReadonlyArray<TimeseriesRow>
	readonly rateLabel: string
	readonly hasSampling: boolean
	readonly hasTraced: boolean
	readonly hasErrors: boolean
}

/** What `ThroughputAreaChart` derives before it builds marks: the rate rows and which series exist. */
export const throughputPlot = (model: FixedMetricModel, perSecond: boolean): ThroughputPlot => {
	const rows = deriveThroughputRows(
		model.plotRows,
		perSecond && model.bucketSeconds ? model.bucketSeconds : 1,
	)
	return {
		rows,
		rateLabel: perSecond ? "/s" : bucketIntervalLabel(model.bucketSeconds),
		hasSampling: rows.some((row) => row.hasSampling === true),
		hasTraced: rows.some((row) => typeof row[TRACED_KEY] === "number"),
		hasErrors: rows.some((row) => {
			const value = row[ERROR_KEY]
			return typeof value === "number" && value > 0
		}),
	}
}

/** The throughput chart's legend series: every line it draws, the traced reference included. */
export const throughputLegend = (
	plot: ThroughputPlot,
	colors: Readonly<{ throughput: string; error: string }>,
): ReadonlyArray<FixedMetricSeries> => {
	const { rateLabel } = plot
	const suffix = rateLabel ? ` (${rateLabel})` : ""
	const throughputLabel = `${plot.hasSampling ? "Estimated throughput" : "Throughput"}${suffix}`
	return [
		{ key: THROUGHPUT_KEY, label: throughputLabel, color: colors.throughput },
		...(plot.hasErrors
			? [
					{
						key: ERROR_KEY,
						label: `Errors${suffix}`,
						color: colors.error,
						dashed: true,
					},
				]
			: []),
		...(plot.hasTraced
			? [{ key: TRACED_KEY, label: `Traced${suffix}`, color: colors.throughput, dashed: true }]
			: []),
	]
}

// copied: `LATENCY_TOKENS` / `LATENCY_LABELS` (latency-line-chart.tsx), paint order p99 first.
export const LATENCY_SERIES = [
	{ key: "p99LatencyMs", label: "P99", token: "--chart-p99" },
	{ key: "p95LatencyMs", label: "P95", token: "--chart-p95" },
	{ key: "p50LatencyMs", label: "P50", token: "--chart-p50" },
] as const
