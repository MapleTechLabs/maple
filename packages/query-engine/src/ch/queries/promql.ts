// PromQL selector data: one stored metric component (value, histogram bucket, count or sum),
// per series, its samples in `(startMs, endMs]` aggregated into evaluation buckets.
//
// Stages: scan with pushed-down label matchers; series key and sample value (delta sums
// accumulated into counters for rate functions only); previous sample and next stale marker per
// series; per (series, bucket) statistics; one row per series with them as parallel arrays.

import { Array as Arr, Schema, SchemaGetter } from "effect"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { from, fromQuery, param, sql, table } from "@maple-dev/effect-orm/clickhouse"
import * as CH from "@maple-dev/effect-orm/expr"
import { CHNumber } from "../schema"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgId, orgIdParam, utcSecondsParam } from "../tables"
import { labelSetExpr, labelValueExpr } from "../../promql/labels"
import { utcHourFloor } from "./query-helpers"

/** Joins a stored metric's name and unit into the identity a selector row reports. */
export const METRIC_UNIT_SEPARATOR = "\u001f"

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
	/** Stored (OTel name, unit) pairs; one query reads them all. */
	readonly targets: ReadonlyArray<{ readonly metricName: string; readonly unit: string }>
	/** 0: one bucket per sample. */
	readonly widthMs: number
	/** Also return each bucket's values in time order (raw mode). */
	readonly needsValues: boolean
	/**
	 * Read delta-temporality samples as a running counter from the read's start (rate, increase,
	 * irate: their differences do not depend on it). Otherwise each delta is a sample as it is, so
	 * a bare selector or `*_over_time` does not change with the query range (Prometheus 3 deltas).
	 */
	readonly accumulateDeltas: boolean
	/** Rows returned at most; pass the series cap plus one to detect overflow. */
	readonly limit: number
	/** Label matchers as WHERE conditions, built from the table's columns. */
	readonly conditions: ($: PromqlLabelColumns) => ReadonlyArray<CH.Condition | undefined>
	/** `le` matchers on the expanded bucket bound, applied before the limit (`bucket` only). */
	readonly boundConditions: (le: CH.Expr<number>) => ReadonlyArray<CH.Condition | undefined>
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

const parseFloatText = (text: string): number => {
	if (text === "inf" || text === "+inf") return Infinity
	if (text === "-inf") return -Infinity
	if (text === "nan" || text === "-nan") return Number.NaN
	return Number(text)
}

/** A Float64 sent as text so NaN and the infinities survive JSON (`inf`, `-inf`, `nan`); a plain number too. */
export const CHFloatText = Schema.Union([
	Schema.Number,
	Schema.String.pipe(
		Schema.decodeTo(Schema.Number, {
			decode: SchemaGetter.transform(parseFloatText),
			encode: SchemaGetter.transform((value: number) => String(value)),
		}),
	),
])

/** A Float64 column ClickHouse writes as text; it decodes to a number, NaN and infinities included. */
const floatText = T.custom("String", CHFloatText)

const metricTable = (name: PromqlMetricTable) =>
	table(name, {
		external: true,
		// Without it the OrgId filter does not count and the warehouse refuses every read as untenanted.
		tenantColumn: "OrgId",
		columns: {
			OrgId: orgId,
			MetricName: T.string,
			MetricUnit: T.string,
			ServiceName: T.string,
			Attributes: stringMap,
			ResourceAttributes: stringMap,
			TimeUnix: T.dateTime64,
		},
	})

/** A classic histogram row's bounds, `+Inf` last. */
const CLASSIC_BOUNDS = "arrayPushBack(ExplicitBounds, inf)"

/** Whether a histogram row's buckets line up with its bounds. */
export const bucketsValidSql = (tableName: PromqlMetricTable): string =>
	tableName === "metrics_histogram" ? "length(BucketCounts) = length(ExplicitBounds) + 1" : "1"

/** The sample of one stored row as `[le, value]`; histogram buckets expand into one row per bound. */
const samplePair = (component: PromqlComponent) => {
	switch (component) {
		case "bucket":
			// Histogram buckets expand after the scan, once the series' bounds are known.
			return sql(T.array(T.float64))`[0, 0]`
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

/** NaN and infinities are samples, as in Prometheus; only bucket arrays that do not line up drop. */
const validSampleCond = (tableName: PromqlMetricTable, component: PromqlComponent) =>
	component === "bucket"
		? sql.cond`(bitAnd(Flags, 1) = 1 OR ${sql.raw(bucketsValidSql(tableName))})`
		: undefined

const isExponentialBuckets = (opts: PromqlSelectorOpts): boolean =>
	opts.table === "metrics_exponential_histogram" && opts.component === "bucket"

const isClassicBuckets = (opts: PromqlSelectorOpts): boolean =>
	opts.table === "metrics_histogram" && opts.component === "bucket"

/**
 * What an exponential histogram needs to read as classic `_bucket` series: its buckets, and over
 * the series in the read its coarsest scale m and the base-2 exponents of its lowest and highest
 * bucket edges. Every export is then brought to scale m (exact: coarse bounds are a subset of
 * fine ones) and emits its cumulative count at every bound the series needs (`exponentialPair`),
 * so each bound stays complete when the occupied range shifts, and a stale export marks them all.
 */
const histogramColumns = (
	opts: PromqlSelectorOpts,
	$: PromqlLabelColumns & { readonly MetricName: CH.Expr<string>; readonly MetricUnit: CH.Expr<string> },
) => {
	const series = sql`cityHash64(${$.MetricName}, ${$.MetricUnit}, ${labelSetExpr($, true)})`
	const none = {
		scale: sql(T.int64)`toInt64(0)`,
		offset: sql(T.int64)`toInt64(0)`,
		counts: sql(T.array(T.float64))`emptyArrayFloat64()`,
		below: sql(T.float64)`toFloat64(0)`,
		m: sql(T.int64)`toInt64(0)`,
		lowExp: sql(T.float64)`toFloat64(0)`,
		highExp: sql(T.float64)`toFloat64(0)`,
		bounds: sql(T.array(T.float64))`emptyArrayFloat64()`,
		seriesBounds: sql(T.array(T.float64))`emptyArrayFloat64()`,
	}
	// A classic histogram's cumulative counts, and every bound the series has so a stale export
	// (which carries no buckets) marks each of them.
	if (isClassicBuckets(opts))
		return {
			...none,
			counts: sql(T.array(T.float64))`arrayMap(c -> toFloat64(c), arrayCumSum(BucketCounts))`,
			bounds: sql(T.array(T.float64))`ExplicitBounds`,
			seriesBounds: sql(
				T.array(T.float64),
			)`arraySort(groupUniqArrayArrayIf(ExplicitBounds, ${sql.raw(bucketsValidSql(opts.table))}) OVER (PARTITION BY ${series}))`,
		}
	if (!isExponentialBuckets(opts)) return none
	const occupied = sql.raw("length(PositiveBucketCounts) > 0")
	return {
		...none,
		scale: sql(T.int64)`toInt64(Scale)`,
		offset: sql(T.int64)`toInt64(PositiveOffset)`,
		counts: sql(T.array(T.float64))`arrayMap(c -> toFloat64(c), PositiveBucketCounts)`,
		// Negative values and the zero bucket lie below every positive bound.
		below: sql(T.float64)`toFloat64(arraySum(NegativeBucketCounts) + ZeroCount)`,
		// Only exports with buckets: a stale one carries scale 0 and must not coarsen the rest.
		m: sql(T.int64)`toInt64(minIf(Scale, ${occupied}) OVER (PARTITION BY ${series}))`,
		lowExp: sql(
			T.float64,
		)`minIf(PositiveOffset * exp2(-Scale), ${occupied}) OVER (PARTITION BY ${series})`,
		highExp: sql(
			T.float64,
		)`maxIf((PositiveOffset + length(PositiveBucketCounts)) * exp2(-Scale), ${occupied}) OVER (PARTITION BY ${series})`,
	}
}

/** A classic export's `[le, cumulative]` pairs; a stale one marks every bound of its series. */
const classicPair = ($: {
	readonly stale: CH.Expr<number>
	readonly counts: CH.Expr<ReadonlyArray<number>>
	readonly bounds: CH.Expr<ReadonlyArray<number>>
	readonly seriesBounds: CH.Expr<ReadonlyArray<number>>
}) =>
	sql(
		T.array(T.float64),
	)`arrayJoin(if(${$.stale} = 1, arrayMap(b -> [b, 0], arrayPushBack(${$.seriesBounds}, inf)), arrayMap((b, c) -> [b, c], arrayPushBack(${$.bounds}, inf), ${$.counts})))`

/** Finite bounds one exponential series expands to at most, about one export's worth of buckets. */
const MAX_EXPONENTIAL_BOUNDS = 160

/**
 * The bound grid of an exponential series: indices k of the bounds 2^(k*2^-m) from below its lowest
 * edge to above its highest, at its coarsest scale m, coarser still when the range would need more
 * than MAX_EXPONENTIAL_BOUNDS (sparse data at a fine scale): exact at coarser bounds, and small.
 */
const exponentialGrid = (scale: CH.Expr<number>, lowExp: CH.Expr<number>, highExp: CH.Expr<number>) => {
	const span = sql`(${highExp} - ${lowExp}) * exp2(${scale})`
	const m = sql`(${scale} - toInt64(greatest(0, ceil(log2(greatest(${span}, 1) / ${MAX_EXPONENTIAL_BOUNDS})))))`
	const kLo = sql`toInt64(floor(${lowExp} * exp2(${m})))`
	const kHi = sql`toInt64(ceil(${highExp} * exp2(${m})))`
	return {
		m,
		ks: sql`arrayMap(x -> ${kLo} + toInt64(x), range(toUInt64(greatest(${kHi} - ${kLo} + 1, 0))))`,
	}
}

/** The grid's bounds (`+Inf` last) for series discovery, from the series' exports aggregated in the read. */
const exponentialDiscoveryGrid = () => {
	const occupied = sql.raw("length(PositiveBucketCounts) > 0")
	const { m, ks } = exponentialGrid(
		sql(T.int64)`toInt64(minIf(Scale, ${occupied}))`,
		sql(T.float64)`minIf(PositiveOffset * exp2(-Scale), ${occupied})`,
		sql(T.float64)`maxIf((PositiveOffset + length(PositiveBucketCounts)) * exp2(-Scale), ${occupied})`,
	)
	return sql(T.array(T.float64))`arrayPushBack(arrayMap(k -> exp2(k * exp2(-${m})), ${ks}), inf)`
}

/** One export's cumulative counts at the bounds 2^(k*2^-m) from below its lowest edge to above its highest. */
const exponentialPair = ($: {
	readonly scale: CH.Expr<number>
	readonly offset: CH.Expr<number>
	readonly counts: CH.Expr<ReadonlyArray<number>>
	readonly below: CH.Expr<number>
	readonly m: CH.Expr<number>
	readonly lowExp: CH.Expr<number>
	readonly highExp: CH.Expr<number>
}) => {
	const { m, ks } = exponentialGrid($.m, $.lowExp, $.highExp)
	const atBound = sql`${$.below} + arraySum(arrayMap((c, j) -> if(${$.offset} + j - 1 < k * exp2(${$.scale} - ${m}), c, 0), ${$.counts}, arrayEnumerate(${$.counts})))`
	return sql(
		T.array(T.float64),
	)`arrayJoin(arrayPushBack(arrayMap(k -> [exp2(k * exp2(-${m})), ${atBound}], ${ks}), [inf, ${$.below} + arraySum(${$.counts})]))`
}

const scanQuery = (opts: PromqlSelectorOpts) =>
	from(metricTable(opts.table))
		.select(($) => ({
			// Name and unit together: one name in two units is two metrics (`_seconds`, `_milliseconds`).
			MetricName: sql(T.string)`concat(${$.MetricName}, ${METRIC_UNIT_SEPARATOR}, ${$.MetricUnit})`,
			ServiceName: $.ServiceName,
			Attributes: $.Attributes,
			ResourceAttributes: $.ResourceAttributes,
			t: sql(T.int64)`toUnixTimestamp64Milli(${$.TimeUnix})`,
			isDelta: isDeltaExpr(opts.table),
			// A no-recorded-value point (a failed scrape) is a stale marker, not a sample.
			stale: sql(T.uint8)`bitAnd(Flags, 1)`,
			pair: samplePair(opts.component),
			...histogramColumns(opts, $),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.MetricName.in_(...Arr.dedupe(Arr.map(opts.targets, (t) => t.metricName))),
			sql.cond`(${$.MetricName}, ${$.MetricUnit}) IN (${sql.join(
				Arr.map(opts.targets, (t) => sql`(${t.metricName}, ${t.unit})`),
				", ",
			)})`,
			sql.cond`${$.TimeUnix} > fromUnixTimestamp64Milli(toInt64(${param.int("startMs")}))`,
			sql.cond`${$.TimeUnix} <= fromUnixTimestamp64Milli(toInt64(${param.int("endMs")}))`,
			validSampleCond(opts.table, opts.component),
			...opts.conditions($),
		])

/**
 * The series key: the series' resolved labels and nothing else, so rows that differ only in a
 * value the labels hide (a dropped resource key, an overridden or empty one) stay one series.
 */
/** Each sample as `[le, value]`: an exponential export expands into its bounds here, once. */
const sampledQuery = (opts: PromqlSelectorOpts) =>
	fromQuery(scanQuery(opts), "scan").select(($) => ({
		MetricName: $.MetricName,
		ServiceName: $.ServiceName,
		Attributes: $.Attributes,
		ResourceAttributes: $.ResourceAttributes,
		t: $.t,
		isDelta: $.isDelta,
		stale: $.stale,
		pair: isExponentialBuckets(opts)
			? exponentialPair($)
			: isClassicBuckets(opts)
				? classicPair($)
				: $.pair,
	}))

const keyedQuery = (opts: PromqlSelectorOpts) =>
	fromQuery(sampledQuery(opts), "sampled")
		.select(($) => ({
			sk: sql(
				T.uint64,
			)`cityHash64(${$.MetricName}, ${labelSetExpr($, opts.component === "bucket")}, ${$.pair}[1])`,
			MetricName: $.MetricName,
			ServiceName: $.ServiceName,
			Attributes: $.Attributes,
			ResourceAttributes: $.ResourceAttributes,
			t: $.t,
			isDelta: $.isDelta,
			stale: $.stale,
			le: sql(T.float64)`${$.pair}[1]`,
			raw: sql(T.float64)`${$.pair}[2]`,
		}))
		// sk includes the bound, so whole series drop before the window and the limit.
		.where(($) => (opts.component === "bucket" ? opts.boundConditions(sql(T.float64)`${$.pair}[1]`) : []))

/**
 * Each sample's value, the series' previous sample and the first stale marker after it. Stale
 * markers are their own partition for the previous sample, add nothing to the counter, and drop after.
 */
const windowedQuery = (opts: PromqlSelectorOpts) =>
	fromQuery(keyedQuery(opts), "keyed").select(($) => {
		const lag = CH.windowSpec({
			partitionBy: [$.sk, $.stale],
			orderBy: [[$.t, "asc"]],
			frame: CH.rowsBetween(CH.preceding(1), CH.currentRow),
		})
		// Over the whole series: a stale marker adds nothing to the counter instead of restarting it.
		const running = CH.windowSpec({
			partitionBy: [$.sk],
			orderBy: [[$.t, "asc"]],
			frame: CH.rowsBetween(CH.unboundedPreceding, CH.currentRow),
		})
		// Descending, so the lag is the series' next row, stale or not.
		const next = CH.windowSpec({
			partitionBy: [$.sk],
			orderBy: [[$.t, "desc"]],
			frame: CH.rowsBetween(CH.preceding(1), CH.currentRow),
		})
		// A counter from twice the deltas' total, as if started long ago: extrapolation never stops at
		// zero, the result does not depend on the read start, and tiny deltas keep their precision.
		const delta = sql(T.float64)`if(${$.stale} = 1, 0, ${$.raw})`
		const baseline = sql(T.float64)`2 * sum(abs(${delta})) OVER (PARTITION BY ${$.sk})`
		const cumulative = sql(T.float64)`${CH.over(CH.sum(delta), running)} + ${baseline}`
		const accumulate = opts.accumulateDeltas ? $.isDelta : sql(T.uint8)`0`
		const nextStale = CH.over(CH.lagInFrame($.stale, 1, $.stale), next)
		return {
			sk: $.sk,
			MetricName: $.MetricName,
			ServiceName: $.ServiceName,
			Attributes: $.Attributes,
			ResourceAttributes: $.ResourceAttributes,
			le: $.le,
			t: $.t,
			stale: $.stale,
			staleT: sql(
				T.float64,
			)`if(${nextStale} = 1, toFloat64(${CH.over(CH.lagInFrame($.t, 1, $.t), next)}), 0)`,
			v: sql(T.float64)`if(${accumulate} = 1, ${cumulative}, ${$.raw})`,
			pv: sql(
				T.float64,
			)`if(${accumulate} = 1, ${cumulative} - ${$.raw}, ${CH.over(CH.lagInFrame($.raw, 1, $.raw), lag)})`,
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
	fromQuery(windowedQuery(opts), "windowed")
		.select(($) => {
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
				staleT: $.staleT,
				end,
				// The pair (previous, this) counts in this bucket only when both samples are in it.
				pairIn: sql(T.uint8)`${$.n} = 2 AND ${bucketEndExpr($.pt, opts.widthMs)} = ${end}`,
				ts: sql(T.float64)`(${$.t} - ${param.int("timeOriginMs")}) / 1000`,
			}
		})
		.where(($) => [$.stale.eq(0)])

/** Prometheus' min/max: a NaN gives way to any other value, so NaN only when every value is. */
const nanAwareExtreme = (op: "min" | "max", value: CH.Expr<number>) =>
	sql(T.float64)`if(countIf(NOT isNaN(${value})) = 0, nan, ${sql.raw(op)}If(${value}, NOT isNaN(${value})))`

/** A change between two samples, NaN to NaN not being one (Prometheus' changes()). */
const changed = (v: CH.Expr<number>, previous: CH.Expr<number>) =>
	sql.cond`NOT (${v} = ${previous} OR (isNaN(${v}) AND isNaN(${previous})))`

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
				min: nanAwareExtreme("min", $.v),
				max: nanAwareExtreme("max", $.v),
				sumSquares: sql(T.float64)`sum(${$.v} * ${$.v})`,
				// The value before each counter reset inside the bucket; the engine adds last - first.
				resetSum: sql(T.float64)`sumIf(${$.pv}, ${$.pairIn} = 1 AND ${$.v} < ${$.pv})`,
				resets: sql(T.float64)`countIf(${$.pairIn} = 1 AND ${$.v} < ${$.pv})`,
				changes: sql(T.float64)`countIf(${$.pairIn} = 1 AND ${changed($.v, $.pv)})`,
				staleT: CH.argMax($.staleT, $.t),
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
	"resetSum",
	"resets",
	"changes",
	"sumT",
	"sumTT",
	"sumTV",
	"staleT",
] as const

/** Statistics that can be NaN or infinite, which JSON writes as null: they leave as text. */
const VALUE_FIELDS: ReadonlySet<PromqlBucketField> = new Set([
	"firstV",
	"lastV",
	"prevV",
	"sum",
	"min",
	"max",
	"sumSquares",
	"resetSum",
	"sumTV",
])

export type PromqlBucketField = (typeof BUCKET_FIELDS)[number]

/** One row per series: its labels' sources, and each bucket statistic as an array in bucket order. */
export function promqlSelectorQuery(opts: PromqlSelectorOpts) {
	return fromQuery(bucketQuery(opts), "buckets")
		.select(($) => {
			// Every array in bucket order: sorted by the bucket ends gathered beside it.
			const ends = sql`groupArray(${$.end})`
			const column = (field: PromqlBucketField) =>
				VALUE_FIELDS.has(field)
					? sql(
							T.array(floatText),
						)`arraySort((x, e) -> e, groupArray(toString(toFloat64(${$[field]}))), ${ends})`
					: sql(
							T.array(T.float64),
						)`arraySort((x, e) -> e, groupArray(toFloat64(${$[field]})), ${ends})`
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
				resetSum: column("resetSum"),
				resets: column("resets"),
				changes: column("changes"),
				sumT: column("sumT"),
				sumTT: column("sumTT"),
				sumTV: column("sumTV"),
				staleT: column("staleT"),
				values: sql(
					T.array(T.array(floatText)),
				)`arraySort((x, e) -> e, groupArray(arrayMap(x -> toString(x), ${$.values})), ${ends})`,
			}
		})
		.groupBy("series")
		.limit(opts.limit)
		.format("JSON")
}

const numbers = Schema.Array(CHNumber)

const floats = Schema.Array(CHFloatText)

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
	firstV: floats,
	lastT: numbers,
	lastV: floats,
	prevT: numbers,
	prevV: floats,
	count: numbers,
	sum: floats,
	min: floats,
	max: floats,
	sumSquares: floats,
	resetSum: floats,
	resets: numbers,
	changes: numbers,
	sumT: numbers,
	sumTT: numbers,
	sumTV: floats,
	staleT: numbers,
	values: Schema.Array(floats),
})
export type PromqlSelectorRow = typeof promqlSelectorRowSchema.Type

/** Every stored metric of the org seen in `[startTime, endTime]`, for resolving selector names. */
export function promqlCatalogQuery(opts: { readonly limit: number }) {
	return from(Datasources.metricCatalog)
		.select(($) => ({
			metricName: $.MetricName,
			metricType: $.MetricType,
			unit: $.MetricUnit,
			isMonotonic: sql(T.uint8)`max(${$.IsMonotonic})`,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
		])
		.groupBy("metricName", "metricType", "unit")
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
	| "last"

/** Pushed functions that read delta-temporality samples as a running counter. */
const COUNTER_RATE_FUNCTIONS: ReadonlySet<PromqlPushdownFunction> = new Set(["rate", "increase", "irate"])

export interface PromqlPushdownOpts extends Omit<
	PromqlSelectorOpts,
	"needsValues" | "limit" | "accumulateDeltas"
> {
	readonly func: PromqlPushdownFunction
	readonly rangeMs: number
	/** Evaluation steps; step j is `originMs + j * stepBuckets * widthMs` (offset already applied). */
	readonly steps: number
	readonly stepBuckets: number
	readonly rangeBuckets: number
	readonly limit: number
}

/** The steps whose window holds bucket `k`: `[first, last]`, empty when `first > last`. */
const windowSteps = (opts: PromqlPushdownOpts, k: CH.Expr<number>) => {
	const s = opts.stepBuckets
	const m = opts.rangeBuckets
	return {
		first: sql(T.int64)`toInt64(greatest(0, ceil(${k} / ${s})))`,
		last: sql(T.int64)`toInt64(least(${opts.steps - 1}, floor((${k} + ${m - 1}) / ${s})))`,
	}
}

/**
 * A series' label sources ride on its first bucket that some step's window holds (empty
 * elsewhere), so the fan-out below copies them once per step of that bucket instead of once per
 * (bucket, step). With a range shorter than the step, the series' very first bucket can fall
 * between windows, so "first" is counted over the buckets that fan out at all.
 */
const linkedQuery = (opts: PromqlPushdownOpts, groups: PromqlPushdownGroups) =>
	fromQuery(
		bucketQuery({
			...opts,
			needsValues: false,
			limit: opts.limit,
			accumulateDeltas: COUNTER_RATE_FUNCTIONS.has(opts.func),
		}),
		"buckets",
	).select(($) => {
		const prev = CH.windowSpec({
			partitionBy: [$.sk],
			orderBy: [[$.end, "asc"]],
			frame: CH.rowsBetween(CH.preceding(1), CH.currentRow),
		})
		const earlier = CH.windowSpec({
			partitionBy: [$.sk],
			orderBy: [[$.end, "asc"]],
			frame: CH.rowsBetween(CH.unboundedPreceding, CH.preceding(1)),
		})
		const k = sql(T.int64)`intDiv(${$.end} - ${param.int("originMs")}, ${opts.widthMs})`
		const steps = windowSteps(opts, k)
		const fansOut = sql(T.uint8)`${steps.first} <= ${steps.last}`
		const later = sql.cond`${CH.over(CH.sum(fansOut), earlier)} > 0`
		const emptied = (map: CH.Expr<Record<string, string>>) =>
			sql(stringMap)`if(${later}, mapFilter((_k, _v) -> 0, ${map}), ${map})`
		return {
			sk: $.sk,
			MetricName: sql(T.string)`if(${later}, '', ${$.MetricName})`,
			ServiceName: sql(T.string)`if(${later}, '', ${$.ServiceName})`,
			Attributes: emptied($.Attributes),
			ResourceAttributes: emptied($.ResourceAttributes),
			le: $.le,
			groups: groups($),
			k,
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
			resetSum: $.resetSum,
			resets: $.resets,
			changes: $.changes,
			staleT: $.staleT,
		}
	})

/** Each bucket once per step whose window holds it, with whether its predecessor is in that window too. */
const expandedQuery = (opts: PromqlPushdownOpts, groups: PromqlPushdownGroups) =>
	fromQuery(linkedQuery(opts, groups), "linked").select(($) => {
		const s = opts.stepBuckets
		const m = opts.rangeBuckets
		const steps = windowSteps(opts, $.k)
		const j = sql(T.int64)`arrayJoin(range(${steps.first}, ${steps.last} + 1))`
		return {
			sk: $.sk,
			MetricName: $.MetricName,
			ServiceName: $.ServiceName,
			Attributes: $.Attributes,
			ResourceAttributes: $.ResourceAttributes,
			le: $.le,
			groups: $.groups,
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
			resetSum: $.resetSum,
			resets: $.resets,
			changes: $.changes,
			staleT: $.staleT,
		}
	})

/** The window of every (series, step), recombined from its buckets. */
const windowQuery = (opts: PromqlPushdownOpts, groups: PromqlPushdownGroups) =>
	fromQuery(expandedQuery(opts, groups), "expanded")
		.select(($) => {
			const crossReset = sql(
				T.float64,
			)`sumIf(${$.pLastV}, ${$.prevIn} = 1 AND ${$.firstV} < ${$.pLastV})`
			return {
				sk: $.sk,
				j: $.j,
				// The window's earliest bucket: the series' first (with the labels) when it holds it.
				MetricName: CH.argMin($.MetricName, $.k),
				ServiceName: CH.argMin($.ServiceName, $.k),
				Attributes: CH.argMin($.Attributes, $.k),
				ResourceAttributes: CH.argMin($.ResourceAttributes, $.k),
				le: CH.any_($.le),
				groups: CH.any_($.groups),
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
				min: nanAwareExtreme("min", $.min),
				max: nanAwareExtreme("max", $.max),
				sumSquares: CH.sum($.sumSquares),
				lastStaleT: CH.argMax($.staleT, $.k),
				// Pre-reset values inside the buckets and across their joins; the window adds last - first.
				resetSum: sql(T.float64)`sum(${$.resetSum}) + ${crossReset}`,
				resets: sql(
					T.float64,
				)`sum(${$.resets}) + countIf(${$.prevIn} = 1 AND ${$.firstV} < ${$.pLastV})`,
				changes: sql(
					T.float64,
				)`sum(${$.changes}) + countIf(${$.prevIn} = 1 AND ${changed($.firstV, $.pLastV)})`,
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
	readonly resetSum: CH.Expr<number>
	readonly resets: CH.Expr<number>
	readonly changes: CH.Expr<number>
	readonly lastStaleT: CH.Expr<number>
}

/** Prometheus' extrapolatedRate (rate, increase, delta) over the window ending at step j. */
const extrapolated = (opts: PromqlPushdownOpts, $: WindowRow) => {
	const isCounter = opts.func !== "delta"
	const stepEnd = sql(T.float64)`(${param.int("originMs")} + ${$.j} * ${opts.stepBuckets * opts.widthMs})`
	const difference = sql(T.float64)`(${$.lastV} - ${$.firstV})`
	const result = isCounter ? sql(T.float64)`(${difference} + ${$.resetSum})` : difference
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
			return { value: $.lastV, valid: any }
		case "last": {
			// A stale marker after the last sample, inside the lookback, ends the series.
			const stepEnd = sql(
				T.float64,
			)`(${param.int("originMs")} + ${$.j} * ${opts.stepBuckets * opts.widthMs})`
			return {
				value: $.lastV,
				valid: sql(T.uint8)`${any} AND NOT (${$.lastStaleT} > 0 AND ${$.lastStaleT} <= ${stepEnd})`,
			}
		}
		case "present_over_time":
			return { value: sql(T.float64)`1`, valid: any }
	}
}

const valuedQuery = (opts: PromqlPushdownOpts, groups: PromqlPushdownGroups) =>
	fromQuery(windowQuery(opts, groups), "windows").select(($) => {
		const { value, valid } = windowValue(opts, $)
		return {
			sk: $.sk,
			j: $.j,
			MetricName: $.MetricName,
			ServiceName: $.ServiceName,
			Attributes: $.Attributes,
			ResourceAttributes: $.ResourceAttributes,
			le: $.le,
			groups: $.groups,
			value: sql(T.float64)`toFloat64(${value})`,
			valid: sql(T.uint8)`${valid}`,
		}
	})

/** Per-row group label values, in `by` order; empty for the per-series query. */
type PromqlPushdownGroups = ($: PromqlLabelColumns) => CH.Expr<ReadonlyArray<string>>

const noGroups: PromqlPushdownGroups = () => sql(T.array(T.string))`emptyArrayString()`

/** One row per series: its labels' sources (from its earliest window) and the steps that have a value. */
const pushdownSeriesQuery = (opts: PromqlPushdownOpts) =>
	fromQuery(valuedQuery(opts, noGroups), "valued")
		.select(($) => ({
			series: sql(T.string)`toString(${$.sk})`,
			metricName: CH.argMin($.MetricName, $.j),
			serviceName: CH.argMin($.ServiceName, $.j),
			attributes: CH.argMin($.Attributes, $.j),
			resourceAttributes: CH.argMin($.ResourceAttributes, $.j),
			le: sql(T.string)`toString(any(${$.le}))`,
			groups: sql(T.array(T.string))`emptyArrayString()`,
			steps: sql(T.array(T.float64))`groupArrayIf(toFloat64(${$.j}), ${$.valid} = 1)`,
			values: sql(T.array(floatText))`groupArrayIf(toString(${$.value}), ${$.valid} = 1)`,
		}))
		.groupBy("series")
		.having(($) => [sql.cond`countIf(${$.valid} = 1) > 0`])
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
			return nanAwareExtreme("min", value)
		case "max":
			return nanAwareExtreme("max", value)
		case "count":
			return sql(T.float64)`toFloat64(count())`
		case "group":
			return sql(T.float64)`1`
	}
}

/** One row per group: the group's label values (in `by` order) and its value per step. */
const pushdownGroupQuery = (opts: PromqlPushdownOpts, aggregation: PromqlPushdownAggregation) => {
	const groups: PromqlPushdownGroups = ($) => {
		const labels = aggregation.labels($)
		return labels.length === 0
			? sql(T.array(T.string))`emptyArrayString()`
			: sql(T.array(T.string))`[${sql.join(labels, ", ")}]`
	}
	const perStep = fromQuery(valuedQuery(opts, groups), "valued")
		.select(($) => ({
			j: $.j,
			groups: $.groups,
			gle: aggregation.byLe ? $.le : sql(T.float64)`0`,
			value: aggregate(aggregation.op, $.value),
		}))
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
			values: sql(T.array(floatText))`groupArray(toString(${$.value}))`,
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
	values: floats,
})
export type PromqlPushdownRow = typeof promqlPushdownRowSchema.Type

/** Type, unit and description of every stored metric in the window, for `/api/v1/metadata`. */
export function promqlMetadataQuery(opts: { readonly limit: number }) {
	return (
		from(Datasources.metricCatalog)
			.select(($) => ({
				metricName: $.MetricName,
				metricType: $.MetricType,
				// One name in two units is two metrics (`_seconds`, `_milliseconds`), as in the catalog.
				unit: $.MetricUnit,
				description: CH.any_($.MetricDescription),
				isMonotonic: sql(T.uint8)`max(${$.IsMonotonic})`,
			}))
			.where(($) => [
				$.OrgId.eq(orgIdParam),
				$.Hour.gte(utcHourFloor("startTime")),
				$.Hour.lte(utcSecondsParam("endTime")),
			])
			.groupBy("metricName", "metricType", "unit")
			// Deterministic: the limit and each family's entry order must not depend on scan order.
			.orderBy(["metricName", "asc"], ["metricType", "asc"], ["unit", "asc"])
			.limit(opts.limit)
			.format("JSON")
	)
}

/** A stored metric's identity: one name in two units is two metrics. */
export interface PromqlStoredMetric {
	readonly metricName: string
	readonly unit: string
}

/** The stored metrics a discovery read keeps: listed (name, unit) pairs, or every one in the table. */
export type PromqlStoredMetrics = ReadonlyArray<PromqlStoredMetric> | "all"

/** Params: `orgId`, epoch ms `startMs`/`endMs` (both inclusive). */
export interface PromqlSeriesLabelsOpts {
	readonly table: PromqlMetricTable
	readonly metrics: PromqlStoredMetrics
	/** Label matchers as WHERE conditions, built from the table's columns. */
	readonly conditions: ($: PromqlLabelColumns) => ReadonlyArray<CH.Condition | undefined>
	/** `le` matchers, checked before the limit on the bucket bounds or, for other series, the attributes. */
	readonly le?: {
		/** Stored metrics read as `_bucket` series; a row needs one bound passing `boundConditions`. */
		readonly buckets: PromqlStoredMetrics | undefined
		/** Stored metrics read as series without a bound; a row must pass `otherConditions`. */
		readonly others: PromqlStoredMetrics | undefined
		readonly boundConditions: (le: CH.Expr<number>) => ReadonlyArray<CH.Condition | undefined>
		readonly otherConditions: ($: PromqlLabelColumns) => ReadonlyArray<CH.Condition | undefined>
	}
	readonly limit: number
}

interface StoredMetricColumns extends PromqlLabelColumns {
	readonly MetricName: CH.Expr<string>
	readonly MetricUnit: CH.Expr<string>
}

/** Rows of the listed metrics; `undefined` (no restriction) for every metric. */
const storedMetricsCondition = ($: StoredMetricColumns, metrics: PromqlStoredMetrics) =>
	metrics === "all"
		? undefined
		: CH.and(
				// The name alone narrows by the primary key; the pair is the identity.
				CH.inList($.MetricName, Arr.dedupe(Arr.map(metrics, (m) => m.metricName))),
				sql.cond`(${$.MetricName}, ${$.MetricUnit}) IN (${sql.join(
					Arr.map(metrics, (m) => sql`(${m.metricName}, ${m.unit})`),
					", ",
				)})`,
			)

/** Rows some target of either kind can keep; `undefined` when every row can. */
const leFilterCondition = (
	tableName: PromqlMetricTable,
	$: StoredMetricColumns,
	le: NonNullable<PromqlSeriesLabelsOpts["le"]>,
) => {
	const bounds = CH.and(...le.boundConditions(sql(T.float64)`_b`))
	const sides = [
		le.buckets === undefined
			? undefined
			: {
					cond: CH.and(
						storedMetricsCondition($, le.buckets),
						// An exponential row's bounds depend on its whole series; the label check after the read decides.
						bounds === undefined || tableName === "metrics_exponential_histogram"
							? undefined
							: sql.cond`${sql.raw(bucketsValidSql(tableName))} AND arrayExists(_b -> ${bounds}, ${sql.raw(CLASSIC_BOUNDS)})`,
					),
				},
		le.others === undefined
			? undefined
			: { cond: CH.and(storedMetricsCondition($, le.others), ...le.otherConditions($)) },
	]
	const present = Arr.filter(sides, (side) => side !== undefined)
	// A side with no condition keeps every row, so the filter does too.
	if (Arr.some(present, (side) => side.cond === undefined)) return undefined
	return CH.or(...Arr.map(present, (side) => side.cond))
}

/**
 * An exponential series' `le` bounds exist once its exports are aggregated, so an `le` matcher
 * filters them here, before the limit; only for a read of `_bucket` series alone.
 */
const exponentialLeHaving = (opts: PromqlSeriesLabelsOpts): CH.Condition | undefined => {
	const le = opts.le
	if (opts.table !== "metrics_exponential_histogram" || le === undefined) return undefined
	if (le.buckets === undefined || le.others !== undefined) return undefined
	const bounds = CH.and(...le.boundConditions(sql(T.float64)`_b`))
	return bounds === undefined
		? undefined
		: sql.cond`arrayExists(_b -> ${bounds}, ${exponentialDiscoveryGrid()})`
}

export function promqlSeriesLabelsQuery(opts: PromqlSeriesLabelsOpts) {
	return from(metricTable(opts.table))
		.select(($) => ({
			metricName: sql(T.string)`concat(${$.MetricName}, ${METRIC_UNIT_SEPARATOR}, ${$.MetricUnit})`,
			labelKey: sql(T.string)`toString(cityHash64(${labelSetExpr($, false)}))`,
			serviceName: CH.any_($.ServiceName),
			attributes: CH.any_($.Attributes),
			resourceAttributes: CH.any_($.ResourceAttributes),
			bounds:
				opts.table === "metrics_exponential_histogram"
					? sql(T.array(T.string))`arrayMap(b -> toString(b), ${exponentialDiscoveryGrid()})`
					: opts.table !== "metrics_histogram"
						? sql(T.array(T.string))`emptyArrayString()`
						: sql(
								T.array(T.string),
							)`arrayMap(b -> toString(b), arraySort(groupUniqArrayArrayIf(${sql.raw(CLASSIC_BOUNDS)}, ${sql.raw(bucketsValidSql(opts.table))})))`,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			storedMetricsCondition($, opts.metrics),
			sql.cond`${$.TimeUnix} >= fromUnixTimestamp64Milli(toInt64(${param.int("startMs")}))`,
			sql.cond`${$.TimeUnix} <= fromUnixTimestamp64Milli(toInt64(${param.int("endMs")}))`,
			sql.cond`bitAnd(Flags, 1) = 0`,
			...opts.conditions($),
			opts.le === undefined ? undefined : leFilterCondition(opts.table, $, opts.le),
		])
		.groupBy("metricName", "labelKey")
		.having(() => [exponentialLeHaving(opts)])
		.orderBy(["metricName", "asc"], ["labelKey", "asc"])
		.limit(opts.limit)
		.format("JSON")
}

export const promqlSeriesLabelsRowSchema = Schema.Struct({
	metricName: Schema.String,
	labelKey: Schema.String,
	serviceName: Schema.String,
	attributes: Schema.Record(Schema.String, Schema.String),
	resourceAttributes: Schema.Record(Schema.String, Schema.String),
	bounds: Schema.Array(Schema.String),
})
export type PromqlSeriesLabelsRow = typeof promqlSeriesLabelsRowSchema.Type

/**
 * Distinct `job` or `instance` values in one metric table, built by the same expression as series
 * labels (a datapoint label first, then the resource: `service.namespace/service`,
 * `service.instance.id`). No rollup keeps these, so this reads the table, bounded by org, the
 * millisecond window and the limit.
 */
export function promqlIdentityValuesQuery(opts: {
	readonly table: PromqlMetricTable
	readonly label: "job" | "instance"
	readonly limit: number
}) {
	return from(metricTable(opts.table))
		.select(($) => ({ value: labelValueExpr($, opts.label) ?? sql(T.string)`''` }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			sql.cond`${$.TimeUnix} >= fromUnixTimestamp64Milli(toInt64(${param.int("startMs")}))`,
			sql.cond`${$.TimeUnix} <= fromUnixTimestamp64Milli(toInt64(${param.int("endMs")}))`,
		])
		.groupBy("value")
		.having(() => [sql.cond`value != ''`])
		.orderBy(["value", "asc"])
		.limit(opts.limit)
		.format("JSON")
}

/**
 * Metric data-point attribute values for the raw keys a label name normalizes from, read from the
 * hourly rollup (fed by `metrics_sum` only) so a bare label-values call never scans metric tables.
 */
export function promqlAttributeValuesQuery(opts: {
	readonly scope: "metric" | "resource"
	readonly keys: ReadonlyArray<string>
	readonly limit: number
}) {
	return from(Datasources.attributeValuesHourly)
		.select(($) => ({ attributeValue: $.AttributeValue }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(utcHourFloor("startTime")),
			$.Hour.lte(utcSecondsParam("endTime")),
			$.AttributeScope.eq(opts.scope),
			CH.inList($.AttributeKey, opts.keys),
			$.AttributeValue.neq(""),
		])
		.groupBy("attributeValue")
		.orderBy(["attributeValue", "asc"])
		.limit(opts.limit)
		.format("JSON")
}

export const promqlMetadataRowSchema = Schema.Struct({
	metricName: Schema.String,
	metricType: Schema.String,
	unit: Schema.String,
	description: Schema.String,
	isMonotonic: CHNumber,
})
export type PromqlMetadataRow = typeof promqlMetadataRowSchema.Type
