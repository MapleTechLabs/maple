// PromQL selector data: one stored metric component (value, histogram bucket, count or sum),
// per series, its samples in `(startMs, endMs]` aggregated into evaluation buckets.
//
// Stages: scan with pushed-down label matchers; series key and sample value (delta sums
// accumulated into counters); previous sample per series; per (series, bucket) statistics;
// one row per series with the bucket statistics as parallel arrays.

import { Schema } from "effect"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { from, fromQuery, param, sql, table } from "@maple-dev/effect-orm/clickhouse"
import * as CH from "@maple-dev/effect-orm/expr"
import { CHNumber } from "../schema"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgId, orgIdParam, utcSecondsParam } from "../tables"

export type PromqlMetricTable =
	| "metrics_sum"
	| "metrics_gauge"
	| "metrics_histogram"
	| "metrics_exponential_histogram"

export type PromqlComponent = "value" | "bucket" | "count" | "sum"

/** The columns pushed-down matchers read. */
export interface PromqlLabelColumns {
	readonly Attributes: CH.Expr<Record<string, string>>
	readonly ResourceAttributes: CH.Expr<Record<string, string>>
	readonly ServiceName: CH.Expr<string>
}

export interface PromqlSelectorOpts {
	readonly table: PromqlMetricTable
	readonly component: PromqlComponent
	/** Stored OTel metric names; one query reads them all. */
	readonly metricNames: ReadonlyArray<string>
	/** 0: one bucket per sample. */
	readonly widthMs: number
	/** Also return each bucket's values in time order (raw mode). */
	readonly needsValues: boolean
	/** Rows returned at most; pass the series cap plus one to detect overflow. */
	readonly limit: number
	/** Label matchers as WHERE conditions, built from the table's columns. */
	readonly conditions: ($: PromqlLabelColumns) => ReadonlyArray<CH.Condition | undefined>
}

/** Params: `orgId`, plus epoch ms `startMs`, `endMs`, `originMs` (bucket grid), `timeOriginMs` (regression). */
export interface PromqlSelectorParams {
	readonly orgId: string
	readonly startMs: number
	readonly endMs: number
	readonly originMs: number
	readonly timeOriginMs: number
}

const stringMap = T.map(T.string, T.string)

const metricTable = (name: PromqlMetricTable) =>
	table(name, {
		external: true,
		columns: {
			OrgId: orgId,
			MetricName: T.string,
			ServiceName: T.string,
			Attributes: stringMap,
			ResourceAttributes: stringMap,
			TimeUnix: T.dateTime64,
		},
	})

/** The sample of one stored row as `[le, value]`; histogram buckets expand into one row per bound. */
const samplePair = (component: PromqlComponent) => {
	switch (component) {
		case "bucket":
			return sql(
				T.array(T.float64),
			)`arrayJoin(arrayMap((b, c) -> [b, toFloat64(c)], arrayPushBack(ExplicitBounds, inf), arrayCumSum(BucketCounts)))`
		case "count":
			return sql(T.array(T.float64))`[0, toFloat64(Count)]`
		case "sum":
			return sql(T.array(T.float64))`[0, toFloat64(Sum)]`
		case "value":
			return sql(T.array(T.float64))`[0, Value]`
	}
}

/** Delta temporality (OTel `AggregationTemporality` 1); gauges have no temporality. */
const isDeltaExpr = (tableName: PromqlMetricTable) =>
	tableName === "metrics_gauge" ? sql(T.uint8)`0` : sql(T.uint8)`AggregationTemporality = 1`

const finiteSampleCond = (component: PromqlComponent) => {
	switch (component) {
		case "bucket":
			return sql.cond`length(BucketCounts) = length(ExplicitBounds) + 1`
		case "count":
			return undefined
		case "sum":
			return sql.cond`isFinite(Sum)`
		case "value":
			return sql.cond`isFinite(Value)`
	}
}

const scanQuery = (opts: PromqlSelectorOpts) =>
	from(metricTable(opts.table))
		.select(($) => ({
			MetricName: $.MetricName,
			ServiceName: $.ServiceName,
			Attributes: $.Attributes,
			ResourceAttributes: $.ResourceAttributes,
			t: sql(T.int64)`toUnixTimestamp64Milli(${$.TimeUnix})`,
			isDelta: isDeltaExpr(opts.table),
			pair: samplePair(opts.component),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.MetricName.in_(...opts.metricNames),
			sql.cond`${$.TimeUnix} > fromUnixTimestamp64Milli(toInt64(${param.int("startMs")}))`,
			sql.cond`${$.TimeUnix} <= fromUnixTimestamp64Milli(toInt64(${param.int("endMs")}))`,
			// A no-recorded-value point (a failed scrape) is not a sample.
			sql.cond`bitAnd(Flags, 1) = 0`,
			finiteSampleCond(opts.component),
			...opts.conditions($),
		])

/** The series key: the stored identity of the series, plus the bound for a bucket. */
const keyedQuery = (opts: PromqlSelectorOpts) =>
	fromQuery(scanQuery(opts), "scan").select(($) => ({
		sk: sql(
			T.uint64,
		)`cityHash64(${$.MetricName}, ${$.ServiceName}, mapKeys(${$.Attributes}), mapValues(${$.Attributes}), mapKeys(${$.ResourceAttributes}), mapValues(${$.ResourceAttributes}), ${$.pair}[1])`,
		MetricName: $.MetricName,
		ServiceName: $.ServiceName,
		Attributes: $.Attributes,
		ResourceAttributes: $.ResourceAttributes,
		t: $.t,
		isDelta: $.isDelta,
		le: sql(T.float64)`${$.pair}[1]`,
		raw: sql(T.float64)`${$.pair}[2]`,
	}))

/** Each sample's value and the series' previous sample; delta samples accumulate into a counter. */
const windowedQuery = (opts: PromqlSelectorOpts) =>
	fromQuery(keyedQuery(opts), "keyed").select(($) => {
		const lag = CH.windowSpec({
			partitionBy: [$.sk],
			orderBy: [[$.t, "asc"]],
			frame: CH.rowsBetween(CH.preceding(1), CH.currentRow),
		})
		const running = CH.windowSpec({
			partitionBy: [$.sk],
			orderBy: [[$.t, "asc"]],
			frame: CH.rowsBetween(CH.unboundedPreceding, CH.currentRow),
		})
		const cumulative = CH.over(CH.sum($.raw), running)
		return {
			sk: $.sk,
			MetricName: $.MetricName,
			ServiceName: $.ServiceName,
			Attributes: $.Attributes,
			ResourceAttributes: $.ResourceAttributes,
			le: $.le,
			t: $.t,
			v: sql(T.float64)`if(${$.isDelta} = 1, ${cumulative}, ${$.raw})`,
			pv: sql(
				T.float64,
			)`if(${$.isDelta} = 1, ${cumulative} - ${$.raw}, ${CH.over(CH.lagInFrame($.raw, 1, $.raw), lag)})`,
			pt: CH.over(CH.lagInFrame($.t, 1, $.t), lag),
			n: CH.over(CH.count(), lag),
		}
	})

/** The bucket a time falls in, `(end - width, end]`, as its end; the time itself in raw mode. */
const bucketEndExpr = (time: CH.Expr<number>, widthMs: number) =>
	widthMs > 0
		? sql(
				T.int64,
			)`${param.int("originMs")} + toInt64(ceil((${time} - ${param.int("originMs")}) / ${widthMs})) * ${widthMs}`
		: sql(T.int64)`${time}`

const placedQuery = (opts: PromqlSelectorOpts) =>
	fromQuery(windowedQuery(opts), "windowed").select(($) => {
		const end = bucketEndExpr($.t, opts.widthMs)
		return {
			sk: $.sk,
			MetricName: $.MetricName,
			ServiceName: $.ServiceName,
			Attributes: $.Attributes,
			ResourceAttributes: $.ResourceAttributes,
			le: $.le,
			t: $.t,
			v: $.v,
			pv: $.pv,
			pt: $.pt,
			end,
			// The pair (previous, this) counts in this bucket only when both samples are in it.
			pairIn: sql(T.uint8)`${$.n} = 2 AND ${bucketEndExpr($.pt, opts.widthMs)} = ${end}`,
			ts: sql(T.float64)`(${$.t} - ${param.int("timeOriginMs")}) / 1000`,
		}
	})

const bucketQuery = (opts: PromqlSelectorOpts) =>
	fromQuery(placedQuery(opts), "placed")
		.select(($) => {
			const count = CH.count()
			const lastV = CH.argMax($.v, $.t)
			const lastT = CH.max_($.t)
			return {
				sk: $.sk,
				end: $.end,
				MetricName: CH.any_($.MetricName),
				ServiceName: CH.any_($.ServiceName),
				Attributes: CH.any_($.Attributes),
				ResourceAttributes: CH.any_($.ResourceAttributes),
				le: CH.any_($.le),
				firstT: CH.min_($.t),
				firstV: CH.argMin($.v, $.t),
				lastT,
				lastV,
				prevT: sql(T.float64)`if(${count} >= 2, ${CH.argMax($.pt, $.t)}, ${lastT})`,
				prevV: sql(T.float64)`if(${count} >= 2, ${CH.argMax($.pv, $.t)}, ${lastV})`,
				count,
				sum: CH.sum($.v),
				min: CH.min_($.v),
				max: CH.max_($.v),
				sumSquares: sql(T.float64)`sum(${$.v} * ${$.v})`,
				increase: sql(
					T.float64,
				)`sumIf(if(${$.v} < ${$.pv}, ${$.v}, ${$.v} - ${$.pv}), ${$.pairIn} = 1)`,
				resets: sql(T.float64)`countIf(${$.pairIn} = 1 AND ${$.v} < ${$.pv})`,
				changes: sql(T.float64)`countIf(${$.pairIn} = 1 AND ${$.v} != ${$.pv})`,
				sumT: sql(T.float64)`sum(${$.ts})`,
				sumTT: sql(T.float64)`sum(${$.ts} * ${$.ts})`,
				sumTV: sql(T.float64)`sum(${$.ts} * ${$.v})`,
				values: opts.needsValues
					? sql(T.array(T.float64))`arrayMap(x -> x.2, arraySort(groupArray((${$.t}, ${$.v}))))`
					: sql(T.array(T.float64))`emptyArrayFloat64()`,
			}
		})
		.groupBy("sk", "end")

const BUCKET_FIELDS = [
	"end",
	"firstT",
	"firstV",
	"lastT",
	"lastV",
	"prevT",
	"prevV",
	"count",
	"sum",
	"min",
	"max",
	"sumSquares",
	"increase",
	"resets",
	"changes",
	"sumT",
	"sumTT",
	"sumTV",
] as const

export type PromqlBucketField = (typeof BUCKET_FIELDS)[number]

/** One row per series: its labels' sources, and each bucket statistic as an array in bucket order. */
export function promqlSelectorQuery(opts: PromqlSelectorOpts) {
	return fromQuery(bucketQuery(opts), "buckets")
		.select(($) => {
			// Every array in bucket order: sorted by the bucket ends gathered beside it.
			const ends = sql`groupArray(${$.end})`
			const column = (field: PromqlBucketField) =>
				sql(T.array(T.float64))`arraySort((x, e) -> e, groupArray(toFloat64(${$[field]})), ${ends})`
			return {
				series: sql(T.string)`toString(${$.sk})`,
				metricName: CH.any_($.MetricName),
				serviceName: CH.any_($.ServiceName),
				attributes: CH.any_($.Attributes),
				resourceAttributes: CH.any_($.ResourceAttributes),
				le: sql(T.string)`toString(any(${$.le}))`,
				end: column("end"),
				firstT: column("firstT"),
				firstV: column("firstV"),
				lastT: column("lastT"),
				lastV: column("lastV"),
				prevT: column("prevT"),
				prevV: column("prevV"),
				count: column("count"),
				sum: column("sum"),
				min: column("min"),
				max: column("max"),
				sumSquares: column("sumSquares"),
				increase: column("increase"),
				resets: column("resets"),
				changes: column("changes"),
				sumT: column("sumT"),
				sumTT: column("sumTT"),
				sumTV: column("sumTV"),
				values: sql(
					T.array(T.array(T.float64)),
				)`arraySort((x, e) -> e, groupArray(${$.values}), ${ends})`,
			}
		})
		.groupBy("series")
		.limit(opts.limit)
		.format("JSON")
}

const numbers = Schema.Array(CHNumber)

export const promqlSelectorRowSchema = Schema.Struct({
	series: Schema.String,
	metricName: Schema.String,
	serviceName: Schema.String,
	attributes: Schema.Record(Schema.String, Schema.String),
	resourceAttributes: Schema.Record(Schema.String, Schema.String),
	/** The bucket bound as ClickHouse prints it (`inf` for +Inf); `0` outside `_bucket`. */
	le: Schema.String,
	end: numbers,
	firstT: numbers,
	firstV: numbers,
	lastT: numbers,
	lastV: numbers,
	prevT: numbers,
	prevV: numbers,
	count: numbers,
	sum: numbers,
	min: numbers,
	max: numbers,
	sumSquares: numbers,
	increase: numbers,
	resets: numbers,
	changes: numbers,
	sumT: numbers,
	sumTT: numbers,
	sumTV: numbers,
	values: Schema.Array(numbers),
})
export type PromqlSelectorRow = typeof promqlSelectorRowSchema.Type

/** Every stored metric of the org seen in `[startTime, endTime]`, for resolving selector names. */
export function promqlCatalogQuery(opts: { readonly limit: number }) {
	return from(Datasources.metricCatalog)
		.select(($) => ({
			metricName: $.MetricName,
			metricType: $.MetricType,
			unit: CH.any_($.MetricUnit),
			isMonotonic: sql(T.uint8)`max(${$.IsMonotonic})`,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(CH.toStartOfInterval(CH.toDateTime(utcSecondsParam("startTime")), 3600)),
			$.Hour.lte(utcSecondsParam("endTime")),
		])
		.groupBy("metricName", "metricType")
		.limit(opts.limit)
		.format("JSON")
}

export const promqlCatalogRowSchema = Schema.Struct({
	metricName: Schema.String,
	metricType: Schema.String,
	unit: Schema.String,
	isMonotonic: CHNumber,
})
export type PromqlCatalogRow = typeof promqlCatalogRowSchema.Type

// Pushdown: the source evaluates `func(selector[range])` per (series, step), and optionally
// `op by (labels)` per (group, step), so one value per step leaves ClickHouse instead of every
// bucket. The window of step j holds buckets k in (j*s - m, j*s] (s = step/width, m =
// range/width); each bucket fans out to the steps whose window holds it, and the window is
// recombined exactly as the evaluator does (lib/promql/src/engine/window.ts).

export type PromqlPushdownFunction =
	| "rate"
	| "increase"
	| "delta"
	| "irate"
	| "idelta"
	| "resets"
	| "changes"
	| "avg_over_time"
	| "sum_over_time"
	| "count_over_time"
	| "min_over_time"
	| "max_over_time"
	| "last_over_time"
	| "present_over_time"
	| "stddev_over_time"
	| "stdvar_over_time"
	| "last"

export interface PromqlPushdownOpts extends Omit<PromqlSelectorOpts, "needsValues" | "limit"> {
	readonly func: PromqlPushdownFunction
	readonly rangeMs: number
	/** Evaluation steps; step j is `originMs + j * stepBuckets * widthMs` (offset already applied). */
	readonly steps: number
	readonly stepBuckets: number
	readonly rangeBuckets: number
	readonly limit: number
}

const linkedQuery = (opts: PromqlPushdownOpts) =>
	fromQuery(bucketQuery({ ...opts, needsValues: false, limit: opts.limit }), "buckets").select(($) => {
		const prev = CH.windowSpec({
			partitionBy: [$.sk],
			orderBy: [[$.end, "asc"]],
			frame: CH.rowsBetween(CH.preceding(1), CH.currentRow),
		})
		return {
			sk: $.sk,
			MetricName: $.MetricName,
			ServiceName: $.ServiceName,
			Attributes: $.Attributes,
			ResourceAttributes: $.ResourceAttributes,
			le: $.le,
			k: sql(T.int64)`intDiv(${$.end} - ${param.int("originMs")}, ${opts.widthMs})`,
			pk: sql(
				T.int64,
			)`intDiv(${CH.over(CH.lagInFrame($.end, 1, $.end), prev)} - ${param.int("originMs")}, ${opts.widthMs})`,
			hasPrev: sql(T.uint8)`${CH.over(CH.count(), prev)} = 2`,
			pLastT: CH.over(CH.lagInFrame($.lastT, 1, $.lastT), prev),
			pLastV: CH.over(CH.lagInFrame($.lastV, 1, $.lastV), prev),
			firstT: $.firstT,
			firstV: $.firstV,
			lastT: $.lastT,
			lastV: $.lastV,
			prevT: $.prevT,
			prevV: $.prevV,
			count: $.count,
			sum: $.sum,
			min: $.min,
			max: $.max,
			sumSquares: $.sumSquares,
			increase: $.increase,
			resets: $.resets,
			changes: $.changes,
		}
	})

/** Each bucket once per step whose window holds it, with whether its predecessor is in that window too. */
const expandedQuery = (opts: PromqlPushdownOpts) =>
	fromQuery(linkedQuery(opts), "linked").select(($) => {
		const s = opts.stepBuckets
		const m = opts.rangeBuckets
		const j = sql(
			T.int64,
		)`arrayJoin(range(toInt64(greatest(0, ceil(${$.k} / ${s}))), toInt64(least(${opts.steps - 1}, floor((${$.k} + ${m - 1}) / ${s}))) + 1))`
		return {
			sk: $.sk,
			MetricName: $.MetricName,
			ServiceName: $.ServiceName,
			Attributes: $.Attributes,
			ResourceAttributes: $.ResourceAttributes,
			le: $.le,
			k: $.k,
			j,
			// The pair (predecessor's last sample, this bucket's first) is in the window of step j.
			prevIn: sql(T.uint8)`${$.hasPrev} AND ${$.pk} > ${j} * ${s} - ${m}`,
			pLastT: $.pLastT,
			pLastV: $.pLastV,
			firstT: $.firstT,
			firstV: $.firstV,
			lastT: $.lastT,
			lastV: $.lastV,
			prevT: $.prevT,
			prevV: $.prevV,
			count: $.count,
			sum: $.sum,
			min: $.min,
			max: $.max,
			sumSquares: $.sumSquares,
			increase: $.increase,
			resets: $.resets,
			changes: $.changes,
		}
	})

/** The window of every (series, step), recombined from its buckets. */
const windowQuery = (opts: PromqlPushdownOpts) =>
	fromQuery(expandedQuery(opts), "expanded")
		.select(($) => {
			const crossIncrease = sql(
				T.float64,
			)`sumIf(if(${$.firstV} < ${$.pLastV}, ${$.firstV}, ${$.firstV} - ${$.pLastV}), ${$.prevIn} = 1)`
			return {
				sk: $.sk,
				j: $.j,
				MetricName: CH.any_($.MetricName),
				ServiceName: CH.any_($.ServiceName),
				Attributes: CH.any_($.Attributes),
				ResourceAttributes: CH.any_($.ResourceAttributes),
				le: CH.any_($.le),
				n: sql(T.float64)`sum(${$.count})`,
				firstT: CH.argMin($.firstT, $.k),
				firstV: CH.argMin($.firstV, $.k),
				lastT: CH.argMax($.lastT, $.k),
				lastV: CH.argMax($.lastV, $.k),
				lastCount: CH.argMax($.count, $.k),
				lastPrevT: CH.argMax($.prevT, $.k),
				lastPrevV: CH.argMax($.prevV, $.k),
				lastPrevIn: CH.argMax($.prevIn, $.k),
				lastPLastT: CH.argMax($.pLastT, $.k),
				lastPLastV: CH.argMax($.pLastV, $.k),
				sum: CH.sum($.sum),
				min: CH.min_($.min),
				max: CH.max_($.max),
				sumSquares: CH.sum($.sumSquares),
				increase: sql(T.float64)`sum(${$.increase}) + ${crossIncrease}`,
				resets: sql(
					T.float64,
				)`sum(${$.resets}) + countIf(${$.prevIn} = 1 AND ${$.firstV} < ${$.pLastV})`,
				changes: sql(
					T.float64,
				)`sum(${$.changes}) + countIf(${$.prevIn} = 1 AND ${$.firstV} != ${$.pLastV})`,
			}
		})
		.groupBy("sk", "j")

type WindowRow = {
	readonly j: CH.Expr<number>
	readonly n: CH.Expr<number>
	readonly firstT: CH.Expr<number>
	readonly firstV: CH.Expr<number>
	readonly lastT: CH.Expr<number>
	readonly lastV: CH.Expr<number>
	readonly lastCount: CH.Expr<number>
	readonly lastPrevT: CH.Expr<number>
	readonly lastPrevV: CH.Expr<number>
	readonly lastPrevIn: CH.Expr<number>
	readonly lastPLastT: CH.Expr<number>
	readonly lastPLastV: CH.Expr<number>
	readonly sum: CH.Expr<number>
	readonly min: CH.Expr<number>
	readonly max: CH.Expr<number>
	readonly sumSquares: CH.Expr<number>
	readonly increase: CH.Expr<number>
	readonly resets: CH.Expr<number>
	readonly changes: CH.Expr<number>
}

/** Prometheus' extrapolatedRate (rate, increase, delta) over the window ending at step j. */
const extrapolated = (opts: PromqlPushdownOpts, $: WindowRow) => {
	const isCounter = opts.func !== "delta"
	const stepEnd = sql(T.float64)`(${param.int("originMs")} + ${$.j} * ${opts.stepBuckets * opts.widthMs})`
	const result = isCounter ? sql(T.float64)`${$.increase}` : sql(T.float64)`(${$.lastV} - ${$.firstV})`
	const sampled = sql(T.float64)`((${$.lastT} - ${$.firstT}) / 1000)`
	const between = sql(T.float64)`(${sampled} / (${$.n} - 1))`
	const toStart0 = sql(T.float64)`((${$.firstT} - (${stepEnd} - ${opts.rangeMs})) / 1000)`
	const toStart1 = sql(T.float64)`if(${toStart0} >= ${between} * 1.1, ${between} / 2, ${toStart0})`
	const toZero = sql(T.float64)`(${sampled} * (${$.firstV} / ${result}))`
	const toStart = isCounter
		? sql(
				T.float64,
			)`if(${result} > 0 AND ${$.firstV} >= 0 AND ${toZero} < ${toStart1}, ${toZero}, ${toStart1})`
		: toStart1
	const toEnd0 = sql(T.float64)`((${stepEnd} - ${$.lastT}) / 1000)`
	const toEnd = sql(T.float64)`if(${toEnd0} >= ${between} * 1.1, ${between} / 2, ${toEnd0})`
	const factor = sql(T.float64)`((${sampled} + ${toStart} + ${toEnd}) / ${sampled})`
	const value =
		opts.func === "rate"
			? sql(T.float64)`${result} * ${factor} / ${opts.rangeMs / 1000}`
			: sql(T.float64)`${result} * ${factor}`
	return { value, valid: sql(T.uint8)`${$.n} >= 2 AND ${$.lastT} > ${$.firstT}` }
}

/** irate and idelta: the window's last two samples. */
const instantPair = (opts: PromqlPushdownOpts, $: WindowRow) => {
	const pT = sql(T.float64)`if(${$.lastCount} >= 2, ${$.lastPrevT}, ${$.lastPLastT})`
	const pV = sql(T.float64)`if(${$.lastCount} >= 2, ${$.lastPrevV}, ${$.lastPLastV})`
	const hasPair = sql(T.uint8)`(${$.lastCount} >= 2 OR ${$.lastPrevIn} = 1)`
	const value =
		opts.func === "irate"
			? sql(
					T.float64,
				)`if(${$.lastV} < ${pV}, ${$.lastV}, ${$.lastV} - ${pV}) / ((${$.lastT} - ${pT}) / 1000)`
			: sql(T.float64)`${$.lastV} - ${pV}`
	return { value, valid: sql(T.uint8)`${hasPair} AND ${$.lastT} > ${pT}` }
}

/** The function's value for one (series, step) window, and whether it has one. */
const windowValue = (opts: PromqlPushdownOpts, $: WindowRow) => {
	const any = sql(T.uint8)`${$.n} >= 1`
	const variance = sql(T.float64)`greatest(0, ${$.sumSquares} / ${$.n} - pow(${$.sum} / ${$.n}, 2))`
	switch (opts.func) {
		case "rate":
		case "increase":
		case "delta":
			return extrapolated(opts, $)
		case "irate":
		case "idelta":
			return instantPair(opts, $)
		case "resets":
			return { value: $.resets, valid: any }
		case "changes":
			return { value: $.changes, valid: any }
		case "avg_over_time":
			return { value: sql(T.float64)`${$.sum} / ${$.n}`, valid: any }
		case "sum_over_time":
			return { value: $.sum, valid: any }
		case "count_over_time":
			return { value: $.n, valid: any }
		case "min_over_time":
			return { value: $.min, valid: any }
		case "max_over_time":
			return { value: $.max, valid: any }
		case "last_over_time":
		case "last":
			return { value: $.lastV, valid: any }
		case "present_over_time":
			return { value: sql(T.float64)`1`, valid: any }
		case "stddev_over_time":
			return { value: sql(T.float64)`sqrt(${variance})`, valid: any }
		case "stdvar_over_time":
			return { value: variance, valid: any }
	}
}

const valuedQuery = (opts: PromqlPushdownOpts) =>
	fromQuery(windowQuery(opts), "windows").select(($) => {
		const { value, valid } = windowValue(opts, $)
		return {
			sk: $.sk,
			j: $.j,
			MetricName: $.MetricName,
			ServiceName: $.ServiceName,
			Attributes: $.Attributes,
			ResourceAttributes: $.ResourceAttributes,
			le: $.le,
			value: sql(T.float64)`toFloat64(${value})`,
			valid: sql(T.uint8)`${valid}`,
		}
	})

/** One row per series: its labels' sources and the steps that have a value. */
const pushdownSeriesQuery = (opts: PromqlPushdownOpts) =>
	fromQuery(valuedQuery(opts), "valued")
		.select(($) => ({
			series: sql(T.string)`toString(${$.sk})`,
			metricName: CH.any_($.MetricName),
			serviceName: CH.any_($.ServiceName),
			attributes: CH.any_($.Attributes),
			resourceAttributes: CH.any_($.ResourceAttributes),
			le: sql(T.string)`toString(any(${$.le}))`,
			groups: sql(T.array(T.string))`emptyArrayString()`,
			steps: sql(T.array(T.float64))`groupArray(toFloat64(${$.j}))`,
			values: sql(T.array(T.float64))`groupArray(${$.value})`,
		}))
		.where(($) => [$.valid.eq(1)])
		.groupBy("series")
		.limit(opts.limit)
		.format("JSON")

/** Combine the series of each group; `labels` are label expressions in `by` order, `le` the bucket bound. */
export interface PromqlPushdownAggregation {
	readonly op: "sum" | "avg" | "min" | "max" | "count" | "group"
	readonly labels: ($: PromqlLabelColumns) => ReadonlyArray<CH.Expr<string>>
	readonly byLe: boolean
}

const aggregate = (op: PromqlPushdownAggregation["op"], value: CH.Expr<number>) => {
	switch (op) {
		case "sum":
			return sql(T.float64)`sum(${value})`
		case "avg":
			return sql(T.float64)`avg(${value})`
		case "min":
			return sql(T.float64)`min(${value})`
		case "max":
			return sql(T.float64)`max(${value})`
		case "count":
			return sql(T.float64)`toFloat64(count())`
		case "group":
			return sql(T.float64)`1`
	}
}

/** One row per group: the group's label values (in `by` order) and its value per step. */
const pushdownGroupQuery = (opts: PromqlPushdownOpts, aggregation: PromqlPushdownAggregation) => {
	const perStep = fromQuery(valuedQuery(opts), "valued")
		.select(($) => {
			const labels = aggregation.labels($)
			return {
				j: $.j,
				groups:
					labels.length === 0
						? sql(T.array(T.string))`emptyArrayString()`
						: sql(T.array(T.string))`[${sql.join(labels, ", ")}]`,
				gle: aggregation.byLe ? $.le : sql(T.float64)`0`,
				value: aggregate(aggregation.op, $.value),
			}
		})
		.where(($) => [$.valid.eq(1)])
		.groupBy("j", "groups", "gle")
	return fromQuery(perStep, "per_step")
		.select(($) => ({
			series: sql(T.string)`''`,
			metricName: sql(T.string)`''`,
			serviceName: sql(T.string)`''`,
			attributes: sql(stringMap)`map()`,
			resourceAttributes: sql(stringMap)`map()`,
			le: sql(T.string)`toString(${$.gle})`,
			groups: $.groups,
			steps: sql(T.array(T.float64))`groupArray(toFloat64(${$.j}))`,
			values: sql(T.array(T.float64))`groupArray(${$.value})`,
		}))
		.groupBy("groups", "le")
		.limit(opts.limit)
		.format("JSON")
}

/** Per series. Params: `orgId`, epoch ms `startMs`/`endMs` (scan), `originMs` (step 0's window end), `timeOriginMs`. */
export const promqlPushdownSeriesQuery = pushdownSeriesQuery

/** Per `by` group; same params and row shape as `promqlPushdownSeriesQuery`. */
export const promqlPushdownGroupQuery = pushdownGroupQuery

export const promqlPushdownRowSchema = Schema.Struct({
	series: Schema.String,
	metricName: Schema.String,
	serviceName: Schema.String,
	attributes: Schema.Record(Schema.String, Schema.String),
	resourceAttributes: Schema.Record(Schema.String, Schema.String),
	le: Schema.String,
	groups: Schema.Array(Schema.String),
	steps: numbers,
	values: numbers,
})
export type PromqlPushdownRow = typeof promqlPushdownRowSchema.Type
