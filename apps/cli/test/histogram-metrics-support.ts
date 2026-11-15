// Shared pieces of the histogram metric tests: a world described by raw observations, exported
// the way an SDK would (delta or cumulative, with restarts), and the compiled query run on chDB.

import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import type { MetricsMetric, MetricType } from "@maple/domain/query-engine"
import type { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { Array as Arr, Order, Record as Rec, Schema, String as Str } from "effect"

export const SECOND_MS = 1_000
export const MINUTE_MS = 60_000

/** Hour-aligned and recent: the tables drop rows past their TTL at insert time. */
export const BASE_MS = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 6 * 3_600_000

export interface Observation {
	readonly atMs: number
	readonly value: number
}

export interface HistogramSeries {
	readonly org: string
	readonly metric: string
	readonly service: string
	readonly attributes: Readonly<Record<string, string>>
	/** Explicit upper bounds; bucket i holds values in (bounds[i-1], bounds[i]]. */
	readonly bounds: ReadonlyArray<number>
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

export const ticksOf = (series: HistogramSeries): ReadonlyArray<number> =>
	Arr.makeBy(
		Math.floor((series.lastTickMs - series.firstTickMs) / series.intervalMs) + 1,
		(i) => series.firstTickMs + i * series.intervalMs,
	)

/** Where the sample exported at `tickMs` started counting. */
const countingSince = (series: HistogramSeries, tickMs: number): number => {
	if (series.temporality === "delta") return tickMs - series.intervalMs
	const restarts = Arr.filter(series.restartsAtMs ?? [], (at) => at < tickMs)
	return Math.max(series.firstTickMs - series.intervalMs, ...restarts)
}

const between = (series: HistogramSeries, afterMs: number, untilMs: number): ReadonlyArray<number> =>
	Arr.map(
		Arr.filter(series.observations, (o) => o.atMs > afterMs && o.atMs <= untilMs),
		(o) => o.value,
	)

/** What the sample at `tickMs` adds over the sample before it: the observations a query should count. */
export const increaseAt = (series: HistogramSeries, tickMs: number): ReadonlyArray<number> =>
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

export interface ExponentialSample {
	readonly tickMs: number
	readonly startMs: number
	readonly count: number
	readonly sum: number
	readonly temporality: "delta" | "cumulative"
}

/** One series of exponential histogram samples; their buckets are not what these tests read. */
export const insertExponentialHistogram = (
	db: Chdb,
	org: string,
	metric: string,
	samples: ReadonlyArray<ExponentialSample>,
): void => {
	const rows = Arr.map(
		samples,
		(s) =>
			`(${quote(org)}, 'api', ${quote(metric)}, ${quote(chTimestamp(s.startMs))}, ${quote(chTimestamp(s.tickMs))}, ${s.count}, ${s.sum}, 3, 0, 0, [${s.count}], ${s.temporality === "delta" ? 1 : 2})`,
	)
	db.exec(
		`INSERT INTO metrics_exponential_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, Scale, ZeroCount, PositiveOffset, PositiveBucketCounts, AggregationTemporality) VALUES ${Arr.join(rows, ", ")}`,
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
			`(${quote(org)}, 'api', ${quote(metric)}, ${quote(chTimestamp(s.startMs))}, ${quote(chTimestamp(s.tickMs))}, ${s.count}, ${s.sum}, [${numbers(s.buckets)}], [${numbers(s.bounds)}], ${s.flags ?? 0}, ${quote(s.scope ?? "")}, ${s.temporality === "delta" ? 1 : 2})`,
	)
	db.exec(
		`INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, Flags, ScopeName, AggregationTemporality) VALUES ${Arr.join(rows, ", ")}`,
	)
}
