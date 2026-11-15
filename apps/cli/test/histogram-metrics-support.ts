// Shared pieces of the histogram metric tests: a world described by raw observations, exported
// the way an SDK would (delta or cumulative, with restarts), and the compiled query run on chDB.

import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import type { MetricsMetric, MetricType } from "@maple/domain/query-engine"
import type { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { Array as Arr, Option, Order, Record as Rec, Schema, String as Str } from "effect"

export const SECOND_MS = 1_000
export const MINUTE_MS = 60_000

/** Hour-aligned and recent: the tables drop rows past their TTL at insert time. */
export const BASE_MS = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 6 * 3_600_000

export interface Observation {
	readonly atMs: number
	readonly value: number
}

/** One exported series, whichever way its histogram is bucketed. */
export interface ExportedSeries {
	readonly org: string
	readonly metric: string
	readonly service: string
	readonly attributes: Readonly<Record<string, string>>
	readonly temporality: "delta" | "cumulative"
	readonly intervalMs: number
	readonly firstTickMs: number
	readonly lastTickMs: number
	/** Cumulative only: the process restarted here and lost what it had counted. */
	readonly restartsAtMs?: ReadonlyArray<number>
	/** Whether the SDK records Min and Max on each sample. */
	readonly recordExtrema: boolean
	readonly observations: ReadonlyArray<Observation>
}

export interface HistogramSeries extends ExportedSeries {
	/** Explicit upper bounds; bucket i holds values in (bounds[i-1], bounds[i]]. */
	readonly bounds: ReadonlyArray<number>
}

export interface ExponentialSeries extends ExportedSeries {
	/** The scale an empty histogram starts at. */
	readonly maxScale: number
	/** How many buckets a range holds before the SDK halves its resolution. */
	readonly maxSize: number
}

export const ticksOf = (series: ExportedSeries): ReadonlyArray<number> =>
	Arr.makeBy(
		Math.floor((series.lastTickMs - series.firstTickMs) / series.intervalMs) + 1,
		(i) => series.firstTickMs + i * series.intervalMs,
	)

/** Where the sample exported at `tickMs` started counting. */
const countingSince = (series: ExportedSeries, tickMs: number): number => {
	if (series.temporality === "delta") return tickMs - series.intervalMs
	const restarts = Arr.filter(series.restartsAtMs ?? [], (at) => at < tickMs)
	return Math.max(series.firstTickMs - series.intervalMs, ...restarts)
}

const between = (series: ExportedSeries, afterMs: number, untilMs: number): ReadonlyArray<number> =>
	Arr.map(
		Arr.filter(series.observations, (o) => o.atMs > afterMs && o.atMs <= untilMs),
		(o) => o.value,
	)

/** What the sample at `tickMs` adds over the sample before it: the observations a query should count. */
export const increaseAt = (series: ExportedSeries, tickMs: number): ReadonlyArray<number> =>
	between(series, Math.max(tickMs - series.intervalMs, countingSince(series, tickMs)), tickMs)

export const bucketCounts = (
	bounds: ReadonlyArray<number>,
	values: ReadonlyArray<number>,
): ReadonlyArray<number> =>
	Arr.makeBy(bounds.length + 1, (i) => {
		const lower = i === 0 ? Number.NEGATIVE_INFINITY : (bounds[i - 1] ?? Number.NEGATIVE_INFINITY)
		const upper = bounds[i] ?? Number.POSITIVE_INFINITY
		return Arr.filter(values, (v) => v > lower && v <= upper).length
	})

const quote = (value: string): string =>
	`'${Str.replaceAll("'", "\\'")(Str.replaceAll("\\", "\\\\")(value))}'`

/** `YYYY-MM-DD HH:MM:SS.fff` in UTC. */
export const chTimestamp = (offsetMs: number): string =>
	Str.replace("T", " ")(Str.slice(0, 23)(new Date(BASE_MS + offsetMs).toISOString()))

const mapLiteral = (attributes: Readonly<Record<string, string>>): string =>
	`map(${Arr.join(
		Arr.flatMap(Rec.toEntries(attributes), ([key, value]) => [quote(key), quote(value)]),
		", ",
	)})`

const numbers = (values: ReadonlyArray<number>): string => Arr.join(Arr.map(values, String), ", ")

const numberOrNull = (values: ReadonlyArray<number>, pick: (...v: number[]) => number): string =>
	values.length === 0 ? "NULL" : String(pick(...values))

export const insertHistograms = (db: Chdb, world: ReadonlyArray<HistogramSeries>): void => {
	const rows = Arr.flatMap(world, (series) =>
		Arr.map(ticksOf(series), (tickMs) => {
			const since = countingSince(series, tickMs)
			const values = between(series, since, tickMs)
			const extrema = series.recordExtrema ? values : []
			return `(${quote(series.org)}, ${quote(series.service)}, ${quote(series.metric)}, ${mapLiteral(series.attributes)}, ${quote(chTimestamp(since))}, ${quote(chTimestamp(tickMs))}, ${values.length}, ${Arr.reduce(values, 0, (a, b) => a + b)}, [${numbers(bucketCounts(series.bounds, values))}], [${numbers(series.bounds)}], ${numberOrNull(extrema, Math.min)}, ${numberOrNull(extrema, Math.max)}, ${series.temporality === "delta" ? 1 : 2})`
		}),
	)
	Arr.forEach(Arr.chunksOf(rows, 2_000), (chunk) => {
		db.exec(
			`INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, Attributes, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, Min, Max, AggregationTemporality) VALUES ${Arr.join(chunk, ", ")}`,
		)
	})
}

/** The lowest scale OTLP allows. */
const MIN_SCALE = -10

/** The bucket a magnitude falls in: bucket i covers (base^i, base^(i+1)] with base = 2^(2^-scale). */
export const exponentialIndex = (magnitude: number, scale: number): number => {
	const guess = Math.ceil(Math.log2(magnitude) * 2 ** scale) - 1
	// The logarithm rounds; settle on the bucket whose own edges hold the value.
	if (2 ** (guess * 2 ** -scale) >= magnitude) return guess - 1
	if (2 ** ((guess + 1) * 2 ** -scale) < magnitude) return guess + 1
	return guess
}

/** The values bucket `index` of a positive range holds, as (lower, upper]. */
export const exponentialBounds = (index: number, scale: number): readonly [number, number] => [
	2 ** (index * 2 ** -scale),
	2 ** ((index + 1) * 2 ** -scale),
]

interface ExponentialRange {
	readonly offset: number
	readonly counts: ReadonlyArray<number>
}

const EMPTY_RANGE: ExponentialRange = { offset: 0, counts: [] }

const rangeOf = (magnitudes: ReadonlyArray<number>, scale: number): ExponentialRange => {
	if (magnitudes.length === 0) return EMPTY_RANGE
	const indexes = Arr.map(magnitudes, (m) => exponentialIndex(m, scale))
	const offset = Math.min(...indexes)
	return {
		offset,
		counts: Arr.makeBy(Math.max(...indexes) - offset + 1, (i) =>
			Arr.reduce(indexes, 0, (n, index) => (index === offset + i ? n + 1 : n)),
		),
	}
}

export interface ExponentialBuckets {
	readonly scale: number
	readonly zeroCount: number
	readonly positive: ExponentialRange
	readonly negative: ExponentialRange
}

/** What an SDK holds for `values`: the finest scale, from `maxScale` down, at which both ranges fit `maxSize`. */
export const exponentialBuckets = (
	values: ReadonlyArray<number>,
	maxScale: number,
	maxSize: number,
): ExponentialBuckets => {
	const positive = Arr.filter(values, (v) => v > 0)
	const negative = Arr.map(
		Arr.filter(values, (v) => v < 0),
		(v) => -v,
	)
	const at = (scale: number): ExponentialBuckets => ({
		scale,
		zeroCount: Arr.filter(values, (v) => v === 0).length,
		positive: rangeOf(positive, scale),
		negative: rangeOf(negative, scale),
	})
	const fits = (buckets: ExponentialBuckets) =>
		buckets.positive.counts.length <= maxSize && buckets.negative.counts.length <= maxSize
	const scales = Arr.makeBy(maxScale - MIN_SCALE + 1, (i) => maxScale - i)
	return at(
		Option.getOrElse(
			Arr.findFirst(scales, (scale) => fits(at(scale))),
			() => MIN_SCALE,
		),
	)
}

/** The buckets the sample at `tickMs` carries: an interval's, or everything since the process started. */
export const exportedBuckets = (series: ExponentialSeries, tickMs: number): ExponentialBuckets =>
	exponentialBuckets(
		between(series, countingSince(series, tickMs), tickMs),
		series.maxScale,
		series.maxSize,
	)

export const insertExponentialHistograms = (db: Chdb, world: ReadonlyArray<ExponentialSeries>): void => {
	const rows = Arr.flatMap(world, (series) =>
		Arr.map(ticksOf(series), (tickMs) => {
			const since = countingSince(series, tickMs)
			const values = between(series, since, tickMs)
			const extrema = series.recordExtrema ? values : []
			const buckets = exponentialBuckets(values, series.maxScale, series.maxSize)
			return `(${quote(series.org)}, ${quote(series.service)}, ${quote(series.metric)}, ${mapLiteral(series.attributes)}, ${quote(chTimestamp(since))}, ${quote(chTimestamp(tickMs))}, ${values.length}, ${Arr.reduce(values, 0, (a, b) => a + b)}, ${buckets.scale}, ${buckets.zeroCount}, ${buckets.positive.offset}, [${numbers(buckets.positive.counts)}], ${buckets.negative.offset}, [${numbers(buckets.negative.counts)}], ${numberOrNull(extrema, Math.min)}, ${numberOrNull(extrema, Math.max)}, ${series.temporality === "delta" ? 1 : 2})`
		}),
	)
	Arr.forEach(Arr.chunksOf(rows, 2_000), (chunk) => {
		db.exec(
			`INSERT INTO metrics_exponential_histogram (OrgId, ServiceName, MetricName, Attributes, StartTimeUnix, TimeUnix, Count, Sum, Scale, ZeroCount, PositiveOffset, PositiveBucketCounts, NegativeOffset, NegativeBucketCounts, Min, Max, AggregationTemporality) VALUES ${Arr.join(chunk, ", ")}`,
		)
	})
}

const TimeseriesRow = Schema.Struct({
	bucket: Schema.String,
	groupName: Schema.String,
	value: CH.CHNumber,
	dataPointCount: CH.CHNumber,
	seriesCount: CH.CHNumber,
})
const decodeRows = decodeJsonEachRow(TimeseriesRow)

export interface Point {
	/** Bucket start, as an offset from BASE_MS. */
	readonly atMs: number
	readonly group: string
	readonly value: number
	/** The row's `dataPointCount`. */
	readonly dataPoints: number
}

export interface QueryArgs {
	readonly org: string
	readonly metric: string
	readonly aggregation: Exclude<MetricsMetric, "rate" | "increase">
	readonly fromMs: number
	readonly toMs: number
	readonly bucketSeconds: number
	readonly metricType?: MetricType
	readonly groupByAttributeKey?: string
	readonly groupByService?: boolean
	readonly wholeRange?: boolean
	readonly lookbackSeconds?: number
	readonly seriesLimit?: number
}

const byTimeThenGroup: Order.Order<Point> = Order.combine(
	Order.mapInput(Order.Number, (p: Point) => p.atMs),
	Order.mapInput(Order.String, (p: Point) => p.group),
)

export const queryHistogram = (db: Chdb, args: QueryArgs): ReadonlyArray<Point> => {
	const compiled = CH.compileUnsafe(
		CH.metricsTimeseriesQuery({
			metricType: args.metricType ?? "histogram",
			metric: args.aggregation,
			wholeRange: args.wholeRange,
			lookbackSeconds: args.lookbackSeconds,
			seriesLimit: args.seriesLimit,
			...(args.groupByAttributeKey === undefined
				? undefined
				: { groupBy: ["attribute"], groupByAttributeKey: args.groupByAttributeKey }),
			...(args.groupByService ? { groupBy: ["service"] } : undefined),
		}),
		{
			orgId: args.org,
			metricName: args.metric,
			startTime: Str.slice(0, 19)(chTimestamp(args.fromMs)),
			endTime: Str.slice(0, 19)(chTimestamp(args.toMs)),
			bucketSeconds: args.bucketSeconds,
		},
	)
	return Arr.sort(
		Arr.map(decodeRows(db.query(normalizeSqlForClickHouseClient(compiled.sql))), (row) => ({
			atMs: Date.parse(`${Str.replace(" ", "T")(row.bucket)}Z`) - BASE_MS,
			group: row.groupName,
			value: row.value,
			dataPoints: row.dataPointCount,
		})),
		byTimeThenGroup,
	)
}

/** One gauge series: a reading per second from the start of the range. */
export const insertGaugeReadings = (
	db: Chdb,
	org: string,
	metric: string,
	service: string,
	values: ReadonlyArray<number>,
): void => {
	const rows = Arr.map(
		values,
		(value, i) =>
			`(${quote(org)}, ${quote(service)}, ${quote(metric)}, ${quote(chTimestamp(i * SECOND_MS))}, ${value})`,
	)
	db.exec(
		`INSERT INTO metrics_gauge (OrgId, ServiceName, MetricName, TimeUnix, Value) VALUES ${Arr.join(rows, ", ")}`,
	)
}

export interface ExponentialSample {
	readonly tickMs: number
	readonly startMs: number
	readonly count: number
	readonly sum: number
	readonly temporality?: "delta" | "cumulative"
	readonly scale: number
	readonly zeroCount?: number
	/** Bucket counts from `offset` up; absent means the range is empty. */
	readonly positive?: ExponentialRange
	readonly negative?: ExponentialRange
	readonly service?: string
}

/** Exponential histogram samples written one by one (cumulative unless a sample says otherwise). */
export const insertExponentialSamples = (
	db: Chdb,
	org: string,
	metric: string,
	samples: ReadonlyArray<ExponentialSample>,
): void => {
	const rows = Arr.map(samples, (s) => {
		const positive = s.positive ?? EMPTY_RANGE
		const negative = s.negative ?? EMPTY_RANGE
		return `(${quote(org)}, ${quote(s.service ?? "api")}, ${quote(metric)}, ${quote(chTimestamp(s.startMs))}, ${quote(chTimestamp(s.tickMs))}, ${s.count}, ${s.sum}, ${s.scale}, ${s.zeroCount ?? 0}, ${positive.offset}, [${numbers(positive.counts)}], ${negative.offset}, [${numbers(negative.counts)}], ${s.temporality === "delta" ? 1 : 2})`
	})
	db.exec(
		`INSERT INTO metrics_exponential_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, Scale, ZeroCount, PositiveOffset, PositiveBucketCounts, NegativeOffset, NegativeBucketCounts, AggregationTemporality) VALUES ${Arr.join(rows, ", ")}`,
	)
}

export interface HistogramSample {
	readonly tickMs: number
	readonly startMs: number
	readonly count: number
	readonly sum: number
	readonly bounds: ReadonlyArray<number>
	readonly buckets: ReadonlyArray<number>
	/** OTLP data point flags; 1 marks a point with no recorded value. */
	readonly flags?: number
	/** Instrumentation scope name. */
	readonly scope?: string
	readonly scopeVersion?: string
	readonly temporality?: "delta" | "cumulative"
}

/** One series written sample by sample (cumulative unless a sample says otherwise). */
export const insertCumulativeSamples = (
	db: Chdb,
	org: string,
	metric: string,
	samples: ReadonlyArray<HistogramSample>,
): void => {
	const rows = Arr.map(
		samples,
		(s) =>
			`(${quote(org)}, 'api', ${quote(metric)}, ${quote(chTimestamp(s.startMs))}, ${quote(chTimestamp(s.tickMs))}, ${s.count}, ${s.sum}, [${numbers(s.buckets)}], [${numbers(s.bounds)}], ${s.flags ?? 0}, ${quote(s.scope ?? "")}, ${quote(s.scopeVersion ?? "")}, ${s.temporality === "delta" ? 1 : 2})`,
	)
	db.exec(
		`INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, Flags, ScopeName, ScopeVersion, AggregationTemporality) VALUES ${Arr.join(rows, ", ")}`,
	)
}

const SparklineRow = Schema.Struct({
	bucket: Schema.String,
	metricName: Schema.String,
	avgValue: CH.CHNumber,
	sumValue: CH.CHNumber,
	dataPointCount: CH.CHNumber,
})
const decodeSparklineRows = decodeJsonEachRow(SparklineRow)

export interface RangeArgs {
	readonly org: string
	readonly metric: string
	readonly metricType: MetricType
	readonly fromMs: number
	readonly toMs: number
}

const rangeParams = (args: RangeArgs) => ({
	orgId: args.org,
	startTime: Str.slice(0, 19)(chTimestamp(args.fromMs)),
	endTime: Str.slice(0, 19)(chTimestamp(args.toMs)),
})

/** The catalog sparkline of one metric: [bucket start, average, sum, datapoints] per bucket. */
export const querySparkline = (
	db: Chdb,
	args: RangeArgs & { readonly bucketSeconds: number },
): ReadonlyArray<readonly [number, number, number, number]> => {
	const compiled = CH.compileUnsafe(
		CH.metricsSparklinesQuery({ metricType: args.metricType, metricNames: [args.metric] }),
		{ ...rangeParams(args), bucketSeconds: args.bucketSeconds },
	)
	return Arr.map(
		decodeSparklineRows(db.query(normalizeSqlForClickHouseClient(compiled.sql))),
		(row) =>
			[
				Date.parse(`${Str.replace(" ", "T")(row.bucket)}Z`) - BASE_MS,
				row.avgValue,
				row.sumValue,
				row.dataPointCount,
			] as const,
	)
}

const BreakdownRow = Schema.Struct({
	name: Schema.String,
	avgValue: CH.CHNumber,
	minValue: CH.CHNumber,
	maxValue: CH.CHNumber,
	sumValue: CH.CHNumber,
	count: CH.CHNumber,
})
const decodeBreakdownRows = decodeJsonEachRow(BreakdownRow)

/** The breakdown table of one metric (per service unless `options` says otherwise): [name, average, sum, datapoints] per row, in rank order. */
export const queryBreakdown = (
	db: Chdb,
	args: RangeArgs & { readonly options?: Omit<CH.MetricsBreakdownOpts, "metricType"> },
): ReadonlyArray<readonly [string, number, number, number]> => {
	const compiled = CH.compileUnsafe(
		CH.metricsBreakdownQuery({ ...args.options, metricType: args.metricType }),
		{ ...rangeParams(args), metricName: args.metric },
	)
	return Arr.map(
		decodeBreakdownRows(db.query(normalizeSqlForClickHouseClient(compiled.sql))),
		(row) => [row.name, row.avgValue, row.sumValue, row.count] as const,
	)
}
