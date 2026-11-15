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
import { EXCLUDED_KEY } from "../../promql/labels"

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

/**
 * The series key: everything the series' labels are built from, and nothing else. A resource
 * key the labels drop (service.version, telemetry.sdk.*) must not split a series, or a deploy
 * turns one counter into two with the same labels.
 */
const keyedQuery = (opts: PromqlSelectorOpts) =>
	fromQuery(scanQuery(opts), "scan").select(($) => ({
		sk: sql(
			T.uint64,
		)`cityHash64(${$.MetricName}, ${$.ServiceName}, mapKeys(${$.Attributes}), mapValues(${$.Attributes}), mapKeys(mapFilter((_k, _v) -> NOT ${EXCLUDED_KEY}, ${$.ResourceAttributes})), mapValues(mapFilter((_k, _v) -> NOT ${EXCLUDED_KEY}, ${$.ResourceAttributes})), ${$.ResourceAttributes}['service.name'], ${$.ResourceAttributes}['service.namespace'], ${$.ResourceAttributes}['service.instance.id'], ${$.pair}[1])`,
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
