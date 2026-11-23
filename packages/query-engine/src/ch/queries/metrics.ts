// Typed Metrics Queries
//
// DSL-based query definitions for metrics timeseries, breakdown, and
// a raw-SQL builder for counter rate/increase (which requires CTEs).

import type { DateTime } from "effect"
import { finiteOrZero } from "./format"
import {
	defaultSpaceAggregation,
	METRICS_PERCENTILES,
	isMetricsPercentile,
	type AttributeFilter,
	type MetricsMetric,
	type MetricsPercentile,
	type MetricsSpaceAggregation,
	type MetricType,
} from "@maple/domain/query-engine"
import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { param } from "@maple-dev/effect-orm/clickhouse"
import {
	from,
	fromQuery,
	type CHQuery,
	type ColumnAccessor,
	type ColumnDefs,
} from "@maple-dev/effect-orm/clickhouse"
import { table } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam, utcSecondsParam } from "../tables"
import { resolveMetricTable, metricsSelectExprs, timeseriesBucket, wholeRangeEnd } from "./query-helpers"
import { deploymentEnvExpr } from "@maple/domain/tinybird/semconv-renames"
import { buildAttrFilterCondition } from "../../traces-shared"
import { finalizeTimeseries } from "./series-cap"
import { Array as Arr } from "effect"

/**
 * WHERE conditions for `resourceAttributeFilters` — predicates on the
 * ResourceAttributes map (host.name, k8s.pod.name, …), which carries
 * host/pod/node identity on metrics rows (datapoint labels live on
 * `Attributes` instead).
 */
function resourceFilterConditions(
	filters: readonly AttributeFilter[] | undefined,
): ReadonlyArray<CH.Condition> {
	return Arr.map(filters ?? [], (rf) => buildAttrFilterCondition(rf, "ResourceAttributes"))
}

/** WHERE conditions for `attributeFilters`: any mode or negation on the datapoint Attributes map. */
function datapointFilterConditions(
	filters: readonly AttributeFilter[] | undefined,
): ReadonlyArray<CH.Condition> {
	return Arr.map(filters ?? [], (af) => buildAttrFilterCondition(af, "Attributes"))
}

/** Time aggregations the value tables take; `rate`/`increase` go through `metricsTimeseriesRateQuery`. */
export type MetricsValueAggregation = Exclude<MetricsMetric, "rate" | "increase">

interface MetricsQueryOpts {
	metricType: MetricType
	/** Candidate spellings matched with `MetricName IN (...)`; supersedes the `metricName` param. */
	metricNames?: readonly string[]
	serviceName?: string
	/** Deployment environments to scope to. Empty/undefined means all. */
	environments?: readonly string[]
	groupByAttributeKey?: string
	/** Group by a ResourceAttributes key instead of a datapoint Attributes key. */
	groupByResourceAttributeKey?: string
	/** Several datapoint keys; supersedes `groupByAttributeKey`. */
	groupByAttributeKeys?: readonly string[]
	/** Several resource keys; supersedes `groupByResourceAttributeKey`. */
	groupByResourceAttributeKeys?: readonly string[]
	/** Predicates on the datapoint Attributes map (metric labels). */
	attributeFilters?: readonly AttributeFilter[]
	resourceAttributeFilters?: readonly AttributeFilter[]
	groupBy?: readonly string[]
	seriesLimit?: number
	/** How the series of one group combine. Default: `defaultSpaceAggregation(metric)`. */
	spaceAggregation?: MetricsSpaceAggregation
}

export interface MetricsTimeseriesOpts extends MetricsQueryOpts {
	/** How each series reduces within a bucket. Default: avg. */
	metric?: MetricsValueAggregation
	/** One bucket per group over the whole range; see `timeseriesBucket`. Alert evaluation sets it. */
	wholeRange?: boolean
	/** Histograms only: how far before startTime to read each series' previous sample. Default: bucketSeconds. */
	lookbackSeconds?: number
}

/** One group's value in one bucket. `groupName` is "" when the query has no group-by. */
export interface MetricsTimeseriesOutput {
	readonly bucket: DateTime.Utc
	readonly groupName: string
	readonly value: number
	/** Datapoints behind the value: for a histogram its observations, or its samples under count and sum. */
	readonly dataPointCount: number
	/** Distinct series (service + attributes + resource) combined into the value. */
	readonly seriesCount: number
}

const metricsTimeseriesColumns = {
	bucket: T.dateTime,
	groupName: T.string,
	value: T.float64,
	dataPointCount: T.uint64,
	seriesCount: T.uint64,
}

type MetricsRow = ColumnAccessor<typeof Datasources.metricsSum.columns>

const keysOf = (many: readonly string[] | undefined, one: string | undefined): readonly string[] =>
	many !== undefined && many.length > 0 ? many : one ? [one] : []

/**
 * The group label: the requested dimensions in `groupBy` order, empty values
 * dropped, joined with " · ". The same composition alert group keys always used,
 * so a stored incident keeps its key.
 */
export function metricsGroupNameExpr(
	$: Pick<MetricsRow, "ServiceName" | "Attributes" | "ResourceAttributes">,
	opts: Pick<
		MetricsQueryOpts,
		| "groupBy"
		| "groupByAttributeKey"
		| "groupByAttributeKeys"
		| "groupByResourceAttributeKey"
		| "groupByResourceAttributeKeys"
	>,
): CH.Expr<string> {
	const parts: CH.Expr<string>[] = []
	for (const dim of opts.groupBy ?? []) {
		if (dim === "service") parts.push($.ServiceName)
		else if (dim === "attribute")
			for (const key of keysOf(opts.groupByAttributeKeys, opts.groupByAttributeKey))
				parts.push($.Attributes.get(key))
		else if (dim === "resource_attribute")
			for (const key of keysOf(opts.groupByResourceAttributeKeys, opts.groupByResourceAttributeKey))
				parts.push($.ResourceAttributes.get(key))
	}
	if (parts.length === 0) return CH.lit("")
	if (parts.length === 1 && parts[0] !== undefined) return parts[0]
	return CH.arrayStringConcat(CH.arrayFilter("x -> x != ''", CH.arrayOf(...parts)), " · ")
}

/** Identity of one emitting series: its service, datapoint labels and resource. */
export function metricsSeriesKeyExpr(
	$: Pick<MetricsRow, "ServiceName" | "Attributes" | "ResourceAttributes">,
) {
	return CH.cityHash64(
		$.ServiceName,
		CH.mapKeys($.Attributes),
		CH.mapValues($.Attributes),
		CH.mapKeys($.ResourceAttributes),
		CH.mapValues($.ResourceAttributes),
	)
}

function timeAggregationExpr($: MetricsRow, metric: MetricsValueAggregation): CH.Expr<number> {
	switch (metric) {
		case "avg":
			return finiteOrZero(CH.avg($.Value))
		case "sum":
			return CH.sum($.Value)
		case "min":
			return CH.min_($.Value)
		case "max":
			return CH.max_($.Value)
		case "count":
			return CH.toFloat64(CH.count())
		case "latest":
			return CH.argMax($.Value, $.TimeUnix)
		case "p50":
		case "p75":
		case "p90":
		case "p95":
		case "p99":
			return finiteOrZero(CH.quantile(METRICS_PERCENTILES[metric])($.Value))
	}
}

export function spaceAggregationExpr<Q>(value: CH.Expr<number, Q>, aggregation: MetricsSpaceAggregation) {
	switch (aggregation) {
		case "sum":
			return CH.sum(value)
		case "avg":
			return finiteOrZero(CH.avg(value))
		case "min":
			return CH.min_(value)
		case "max":
			return CH.max_(value)
		case "count":
			return CH.toFloat64(CH.count())
	}
}

type MetricsWhereColumns = Pick<
	| ColumnAccessor<typeof Datasources.metricsSum.columns>
	| ColumnAccessor<typeof Datasources.metricsHistogram.columns>,
	"MetricName" | "OrgId" | "TimeUnix" | "ServiceName" | "Attributes" | "ResourceAttributes"
>

function metricsWhere(
	$: MetricsWhereColumns,
	opts: MetricsTimeseriesOpts,
	start: CH.Expr<DateTime.Utc> = param.dateTime("startTime"),
) {
	return [
		opts.metricNames !== undefined && opts.metricNames.length > 0
			? CH.inList($.MetricName, opts.metricNames)
			: $.MetricName.eq(param.string("metricName")),
		$.OrgId.eq(orgIdParam),
		$.TimeUnix.gte(start),
		$.TimeUnix.lte(param.dateTime("endTime")),
		wholeRangeEnd($.TimeUnix, opts.wholeRange),
		CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		opts.environments !== undefined && opts.environments.length > 0
			? CH.inList(deploymentEnvExpr($.ResourceAttributes), opts.environments)
			: undefined,
		...datapointFilterConditions(opts.attributeFilters),
		...resourceFilterConditions(opts.resourceAttributeFilters),
	]
}

/**
 * Sum and gauge rows reduce in two stages, the model every metrics backend
 * uses: each series is reduced within the bucket (`metric`), then the series of
 * a group are combined (`spaceAggregation`). One stage would weight a series by
 * how often it reports: `sum` of a gauge scraped 4x per bucket read 4x high.
 *
 * Histograms merge their observations across series instead; see
 * `histogramTimeseriesQuery`. `spaceAggregation` does not apply to them.
 */
export function metricsTimeseriesQuery(opts: MetricsTimeseriesOpts) {
	const metric = opts.metric ?? "avg"
	const { tbl, isHistogram } = resolveMetricTable(opts.metricType)

	if (isHistogram) return histogramTimeseriesQuery(opts, metric)

	const perSeries = from(tbl as typeof Datasources.metricsSum)
		.select(($) => ({
			bucket: timeseriesBucket($.TimeUnix, opts.wholeRange),
			groupName: metricsGroupNameExpr($, opts),
			series: metricsSeriesKeyExpr($),
			seriesValue: timeAggregationExpr($, metric),
			points: CH.count(),
		}))
		.where(($) => metricsWhere($, opts))
		.groupBy("bucket", "groupName", "series")

	const inner = fromQuery(perSeries, "per_series")
		.select(($) => ({
			bucket: $.bucket,
			groupName: $.groupName,
			value: spaceAggregationExpr(
				$.seriesValue,
				opts.spaceAggregation ?? defaultSpaceAggregation(metric),
			),
			dataPointCount: CH.sum($.points),
			seriesCount: CH.count(),
		}))
		.groupBy("bucket", "groupName")
		.orderBy(["bucket", "asc"])

	return finalizeTimeseries(inner, metricsTimeseriesColumns, "value", opts)
}

// Histogram timeseries

// What a histogram reader takes from `hist_samples` by name. The sample's counters and
// bucket arrays are in the CTE too, read by the SQL constants below.
const histogramSampleColumns = {
	TimeUnix: T.dateTime64,
	groupName: T.string,
	series: T.uint64,
	sMin: T.nullable(T.float64),
	sMax: T.nullable(T.float64),
}
const histogramSamples = table("hist_samples", { external: true, columns: histogramSampleColumns })

// A no-recorded-value point (a failed scrape) carries zeros, which would read as a reset.
const HAS_RECORDED_VALUE = CH.rawCond("bitAnd(Flags, 1) = 0")

// A sample counts whole when it carries its own accumulation: delta temporality,
// a series that began inside the scanned range (`fresh`), or a reset (count
// dropped, or a StartTimeUnix that moved to or past the previous sample). A start
// equal to the previous sample's own start is the same accumulation, which is how
// a scraped series reads after its first point. Otherwise only the increase counts.
const SAMPLE_IS_WHOLE =
	"(temporality = 1 OR fresh = 1 OR sCount < prevCount OR (startTime >= prevTime AND startTime > prevStart AND startTime < TimeUnix))"
const OBSERVATIONS = `if(${SAMPLE_IS_WHOLE}, toFloat64(sCount), toFloat64(sCount) - toFloat64(prevCount))`
const OBSERVED_SUM = `if(${SAMPLE_IS_WHOLE}, sSum, sSum - prevSum)`
// New bounds inside one accumulation leave no bucket to subtract from: that sample adds
// no buckets. `arrayResize` keeps the zipped arrays the same length in every branch.
const BUCKET_INCREASE = `multiIf(${SAMPLE_IS_WHOLE}, arrayMap(c -> toFloat64(c), buckets), bounds != prevBounds, arrayMap(c -> toFloat64(0), buckets), arrayMap((c, p) -> greatest(toFloat64(c) - toFloat64(p), 0), buckets, arrayResize(prevBuckets, length(buckets))))`
// Recorded extrema bound the merged distribution only when every sample that added
// observations recorded them; one series' min says nothing about another's values.
const lacksExtrema = (observations: string) => `(isNull(sMin) OR isNull(sMax)) AND ${observations} > 0`
const EXTREMA_COVER_ALL = `countIf(${lacksExtrema(OBSERVATIONS)}) = 0`
// OTLP: N bounds describe N + 1 buckets, the last unbounded. Any other shape has no usable buckets.
const HAS_BUCKETS = "length(buckets) = length(bounds) + 1"
const BUCKET_UPPER_BOUNDS = `if(${HAS_BUCKETS}, arrayPushBack(bounds, inf), emptyArrayFloat64())`
const BUCKET_COUNTS = `if(${HAS_BUCKETS}, ${BUCKET_INCREASE}, emptyArrayFloat64())`

/** Which bucket columns a reader needs. They are most of a row, so only a percentile reads them. */
type HistogramBuckets = "none" | "explicit" | "exponential"

/**
 * One histogram sample next to the previous sample of its series, which is what
 * `SAMPLE_IS_WHOLE` reads. Every histogram reader selects through this, so the chart,
 * the sparkline and the breakdown tell series apart and find resets the same way.
 */
function histogramSampleSelect(
	$: ColumnAccessor<typeof Datasources.metricsHistogram.columns>,
	spec: {
		readonly groupName: CH.Expr<string>
		/** Where the scan starts: the range start less the lookback. */
		readonly scanStart: CH.Expr<DateTime.Utc>
		readonly buckets: HistogramBuckets
	},
) {
	// One partition per emitting series, fingerprinted like the counter query, plus the
	// instrumentation scope: two libraries, or two versions of one, can record the same
	// metric with the same labels.
	const onePrecedingFrame = CH.windowSpec({
		partitionBy: [
			$.ServiceName,
			$.MetricName,
			$.ScopeName,
			$.ScopeVersion,
			CH.cityHash64(CH.mapKeys($.Attributes), CH.mapValues($.Attributes)),
			CH.cityHash64(CH.mapKeys($.ResourceAttributes), CH.mapValues($.ResourceAttributes)),
		],
		orderBy: [[$.TimeUnix, "asc"]],
		frame: CH.rowsBetween(CH.preceding(1), CH.currentRow),
	})
	const previous = <A>(value: CH.Expr<A>) => CH.over(CH.lagInFrame(value, 1, value), onePrecedingFrame)
	// A series' first scanned sample that also began in the scanned range has no
	// earlier sample to subtract; without this a process that exports once is lost.
	const fresh = CH.over(CH.count(), onePrecedingFrame)
		.eq(1)
		.and($.StartTimeUnix.gte(spec.scanStart))
		.and($.StartTimeUnix.lt($.TimeUnix))
	const withPrevious = <A>(name: string, type: Parameters<typeof CH.dynamicColumn<A>>[1]) => {
		const value = CH.dynamicColumn<A>(name, type)
		return [value, previous(value)] as const
	}
	const bucketColumns = (): Record<string, CH.Expr<unknown>> => {
		if (spec.buckets === "explicit") {
			return {
				buckets: $.BucketCounts,
				prevBuckets: previous($.BucketCounts),
				bounds: $.ExplicitBounds,
				prevBounds: previous($.ExplicitBounds),
			}
		}
		if (spec.buckets === "exponential") {
			const [scale, prevScale] = withPrevious<number>("Scale", T.int32)
			const [zeroCount, prevZero] = withPrevious<number>("ZeroCount", T.uint64)
			const [posOffset, prevPosOffset] = withPrevious<number>("PositiveOffset", T.int32)
			const [pos, prevPos] = withPrevious<ReadonlyArray<number>>(
				"PositiveBucketCounts",
				T.array(T.uint64),
			)
			const [negOffset, prevNegOffset] = withPrevious<number>("NegativeOffset", T.int32)
			const [neg, prevNeg] = withPrevious<ReadonlyArray<number>>(
				"NegativeBucketCounts",
				T.array(T.uint64),
			)
			return {
				scale,
				prevScale,
				zeroCount,
				prevZero,
				posOffset,
				prevPosOffset,
				pos,
				prevPos,
				negOffset,
				prevNegOffset,
				neg,
				prevNeg,
			}
		}
		return {}
	}
	return {
		TimeUnix: $.TimeUnix,
		groupName: spec.groupName,
		series: metricsSeriesKeyExpr($),
		temporality: $.AggregationTemporality,
		startTime: $.StartTimeUnix,
		prevStart: previous($.StartTimeUnix),
		prevTime: previous($.TimeUnix),
		fresh: CH.if_(fresh, CH.lit(1), CH.lit(0)),
		sCount: $.Count,
		prevCount: previous($.Count),
		sSum: $.Sum,
		prevSum: previous($.Sum),
		sMin: $.Min,
		sMax: $.Max,
		...bucketColumns(),
	}
}

/**
 * The q-quantile of one merged histogram: linear interpolation inside the bucket
 * the rank falls in, as Prometheus' `histogram_quantile` does, except that the
 * unbounded last bucket interpolates up to the recorded max (`bMax`). NaN when
 * it cannot be estimated.
 *
 * `bKeys` and `bCounts` are the non-empty buckets by ascending upper bound
 * (`sumMap` drops a key whose sum is zero), `bTotal` their sum, and `bBounds`
 * every finite bound of the samples that added observations, which is where a
 * bucket's lower edge comes from.
 */
function histogramQuantileSql(q: number): string {
	const rank = `(${q} * bTotal)`
	const cumulative = "arrayCumSum(bCounts)"
	const index = `arrayFirstIndex(c -> c >= ${rank}, ${cumulative})`
	const at = `greatest(${index}, 1)`
	const upper = `bKeys[${at}]`
	const inBucket = `bCounts[${at}]`
	const before = `(${cumulative}[${at}] - ${inBucket})`
	const fraction = `if(${inBucket} > 0, (${rank} - ${before}) / ${inBucket}, 0)`
	const below = `arrayFilter(b -> b < ${upper}, bBounds)`
	// Below the lowest bound the bucket starts at zero, unless that bound is itself negative.
	const lower = `if(empty(${below}), if(${upper} > 0, 0, ${upper}), arrayMax(${below}))`
	const bounded = `${lower} + (${upper} - ${lower}) * ${fraction}`
	const unbounded = `if(empty(bBounds), nan, ${lower} + (greatest(ifNull(bMax, ${lower}), ${lower}) - ${lower}) * ${fraction})`
	return `multiIf(bTotal <= 0 OR ${index} = 0, nan, isInfinite(${upper}), ${unbounded}, ${bounded})`
}

// Exponential histograms
//
// Bucket `i` of a range covers (base^i, base^(i+1)] with base = 2^(2^-scale); the arrays
// are dense from `offset`. One scale lower, bucket `i` is part of bucket `i >> 1`.

// Two samples of one series further apart than this are not one distribution growing,
// and padding one to the other would only cost memory: such a sample adds no buckets.
const EXPONENTIAL_MAX_SPAN = 8192
// Scales are -10..20 on the wire; the cap keeps a nonsense scale from shifting out of range.
const scaleShift = (from: string, to: string) => `least(greatest(${from} - ${to}, 0), 62)`
const asFloats = (counts: string) => `arrayMap(c -> toFloat64(c), ${counts})`

/**
 * `counts`, dense from `offset`, summed into the buckets `shift` scales lower: a running
 * total cut where a coarser bucket ends. The lambda takes scalars only; one that captured
 * an array would copy it per element.
 */
const downscaledSql = (counts: string, offset: string, shift: string) =>
	`if(${shift} = 0, ${asFloats(counts)}, arrayPopFront(arrayDifference(arrayPushFront(arrayFilter((c, i, r) -> r = 1 OR bitAnd(toInt64(${offset}) + i, bitShiftLeft(toInt64(1), ${shift}) - 1) = 0, arrayCumSum(${asFloats(counts)}), arrayEnumerate(${counts}), arrayReverse(arrayEnumerate(${counts}))), toFloat64(0)))))`

/**
 * What one sample adds to one range of its series, as the select aliases `<range>Off`
 * and `<range>Inc`: both samples at `bScale`, laid on one bucket index, the previous
 * subtracted and a negative difference read as zero.
 */
function exponentialRangeIncrease(range: "pos" | "neg") {
	const previous = range === "pos" ? "prevPos" : "prevNeg"
	const cur = `${range}Cur`
	const prev = `${range}Prev`
	const low = `${range}Low`
	const span = `${range}Span`
	// Sizes stay under the cap in every branch, whichever of them ClickHouse evaluates.
	const aligned = (counts: string) =>
		`arrayResize(arrayConcat(arrayWithConstant(least(${counts}Off - ${low}, ${EXPONENTIAL_MAX_SPAN}), toFloat64(0)), ${counts}), least(${span}, ${EXPONENTIAL_MAX_SPAN}))`
	return {
		[cur]: CH.rawExpr(downscaledSql(range, `${range}Offset`, "curShift"), T.array(T.float64)),
		[`${cur}Off`]: CH.rawExpr(`bitShiftRight(toInt64(${range}Offset), curShift)`, T.int64),
		[prev]: CH.rawExpr(
			`if(whole, emptyArrayFloat64(), ${downscaledSql(previous, `${previous}Offset`, "prevShift")})`,
			T.array(T.float64),
		),
		[`${prev}Off`]: CH.rawExpr(`bitShiftRight(toInt64(${previous}Offset), prevShift)`, T.int64),
		[low]: CH.rawExpr(`least(${cur}Off, ${prev}Off)`, T.int64),
		[span]: CH.rawExpr(
			`greatest(${cur}Off + toInt64(length(${cur})), ${prev}Off + toInt64(length(${prev}))) - ${low}`,
			T.int64,
		),
		[`${range}Inc`]: CH.rawExpr(
			`multiIf(empty(${prev}), ${cur}, empty(${cur}) OR ${span} > ${EXPONENTIAL_MAX_SPAN}, emptyArrayFloat64(), arrayMap((c, p) -> greatest(c - p, 0), ${aligned(cur)}, ${aligned(prev)}))`,
			T.array(T.float64),
		),
		[`${range}Off`]: CH.rawExpr(`if(empty(${prev}), ${cur}Off, ${low})`, T.int64),
	}
}

/** The merged buckets of one scale, re-indexed at the group's lowest scale. */
const atLowScale = (keys: string) =>
	`arrayMap(k -> bitShiftRight(k, ${scaleShift("bScale", "lowScale")}), ${keys})`

/**
 * The q-quantile of one merged exponential histogram, walked in value order (`wCounts`,
 * `wKeys`, `wSigns`). Inside a bucket it interpolates on the logarithm, as Prometheus'
 * `histogram_quantile` does for native histograms. The zero bucket reads as 0.
 */
function exponentialQuantileSql(q: number): string {
	const rank = `(${q} * bTotal)`
	const cumulative = "arrayCumSum(wCounts)"
	const index = `arrayFirstIndex(c -> c >= ${rank}, ${cumulative})`
	const at = `greatest(${index}, 1)`
	const inBucket = `wCounts[${at}]`
	const before = `(${cumulative}[${at}] - ${inBucket})`
	const fraction = `if(${inBucket} > 0, (${rank} - ${before}) / ${inBucket}, 0)`
	// Bucket k spans 2^(k / 2^scale) to 2^((k + 1) / 2^scale); a negative one is walked from its far edge.
	const positive = `exp2((wKeys[${at}] + ${fraction}) * exp2(-bLow))`
	const negative = `-exp2((wKeys[${at}] + 1 - ${fraction}) * exp2(-bLow))`
	return `multiIf(bTotal <= 0 OR ${index} = 0, nan, wSigns[${at}] = 0, toFloat64(0), wSigns[${at}] > 0, ${positive}, ${negative})`
}

/** One group's bucket with a percentile estimate and the recorded extrema that bound it. */
interface HistogramEstimate {
	readonly bucket: DateTime.Utc
	readonly groupName: string
	readonly observations: number
	readonly seriesCount: number
	readonly bMin: number | null
	readonly bMax: number | null
	readonly estimate: number
}

/** Every histogram sample in range next to its series' previous one, as the `hist_samples` CTE. */
function histogramSamplesQuery(opts: MetricsTimeseriesOpts, buckets: HistogramBuckets) {
	const { tbl } = resolveMetricTable(opts.metricType)
	const scanStart = CH.intervalSub(
		param.dateTime("startTime"),
		opts.lookbackSeconds ?? param.int("bucketSeconds"),
	)
	const samplesQuery = from(tbl as typeof Datasources.metricsHistogram)
		.select(($) =>
			histogramSampleSelect($, { groupName: metricsGroupNameExpr($, opts), scanStart, buckets }),
		)
		.where(($) => [...metricsWhere($, opts, scanStart), HAS_RECORDED_VALUE])
	return from(histogramSamples).withCTE("hist_samples", samplesQuery)
}

type HistogramSamples = ReturnType<typeof histogramSamplesQuery>

/**
 * Explicit buckets merged per bucket and group: `bKeys` and `bCounts` are the non-empty
 * buckets by ascending upper bound, `bBounds` every finite bound of the samples that
 * added observations (where a bucket's lower edge comes from).
 */
function explicitBucketsMerged(samples: HistogramSamples, opts: MetricsTimeseriesOpts) {
	return samples
		.select(($) => ({
			bucket: timeseriesBucket($.TimeUnix, opts.wholeRange),
			groupName: $.groupName,
			observations: CH.sum(CH.rawExpr(OBSERVATIONS, T.float64)),
			seriesCount: CH.uniqExact($.series),
			bKeys: CH.rawExpr(
				`tupleElement(sumMap(${BUCKET_UPPER_BOUNDS}, ${BUCKET_COUNTS}), 1)`,
				T.array(T.float64),
			),
			bCounts: CH.rawExpr(
				`tupleElement(sumMap(${BUCKET_UPPER_BOUNDS}, ${BUCKET_COUNTS}), 2)`,
				T.array(T.float64),
			),
			bTotal: CH.sum(CH.rawExpr(`arraySum(${BUCKET_COUNTS})`, T.float64)),
			bBounds: CH.rawExpr(
				`arraySort(groupUniqArrayArray(if(arraySum(${BUCKET_COUNTS}) > 0, bounds, emptyArrayFloat64())))`,
				T.array(T.float64),
			),
			bMin: CH.rawExpr(`if(${EXTREMA_COVER_ALL}, min(sMin), NULL)`, T.nullable(T.float64)),
			bMax: CH.rawExpr(`if(${EXTREMA_COVER_ALL}, max(sMax), NULL)`, T.nullable(T.float64)),
		}))
		.where(($) => [$.TimeUnix.gte(param.dateTime("startTime"))])
		.groupBy("bucket", "groupName")
}

/**
 * Exponential buckets merged per bucket and group at the lowest scale a contributing
 * sample has (`bLow`): `posKeys`/`negKeys` are bucket indexes at that scale, `bZero` the
 * zero bucket.
 */
function exponentialBucketsMerged(samples: HistogramSamples, opts: MetricsTimeseriesOpts) {
	// What each sample adds, at `bScale`: its own scale, or the previous sample's when
	// that one is coarser and has buckets to subtract.
	const increases = samples
		.select(($) => ({
			TimeUnix: $.TimeUnix,
			groupName: $.groupName,
			series: $.series,
			sMin: $.sMin,
			sMax: $.sMax,
			sObservations: CH.rawExpr(OBSERVATIONS, T.float64),
			whole: CH.rawExpr(SAMPLE_IS_WHOLE, T.uint8),
			bScale: CH.rawExpr(
				"if(whole OR (empty(prevPos) AND empty(prevNeg)), scale, least(scale, prevScale))",
				T.int32,
			),
			curShift: CH.rawExpr(scaleShift("scale", "bScale"), T.int64),
			prevShift: CH.rawExpr(scaleShift("prevScale", "bScale"), T.int64),
			zeroInc: CH.rawExpr(
				"if(whole, toFloat64(zeroCount), greatest(toFloat64(zeroCount) - toFloat64(prevZero), 0))",
				T.float64,
			),
			...exponentialRangeIncrease("pos"),
			...exponentialRangeIncrease("neg"),
		}))
		.where(($) => [$.TimeUnix.gte(param.dateTime("startTime"))])

	// Samples of one scale add up by bucket index; `sumMap` takes the index as its key.
	const sumByIndex = (range: "pos" | "neg", element: 1 | 2) =>
		`tupleElement(sumMap(range(${range}Off, ${range}Off + toInt64(length(${range}Inc))), ${range}Inc), ${element})`
	const byScale = fromQuery(increases, "exp_increases")
		.select(($) => ({
			bucket: timeseriesBucket($.TimeUnix, opts.wholeRange),
			groupName: $.groupName,
			bScale: $.bScale,
			gObservations: CH.sum($.sObservations),
			gSeries: CH.groupUniqArray($.series),
			gUncovered: CH.countIf(CH.rawCond(lacksExtrema("sObservations"))),
			gMin: CH.min_($.sMin),
			gMax: CH.max_($.sMax),
			gZero: CH.sum($.zeroInc),
			gPosKeys: CH.rawExpr(sumByIndex("pos", 1), T.array(T.int64)),
			gPosCounts: CH.rawExpr(sumByIndex("pos", 2), T.array(T.float64)),
			gNegKeys: CH.rawExpr(sumByIndex("neg", 1), T.array(T.int64)),
			gNegCounts: CH.rawExpr(sumByIndex("neg", 2), T.array(T.float64)),
		}))
		.groupBy("bucket", "groupName", "bScale")

	// A scale whose samples added no buckets does not get to coarsen the others.
	const rescaled = fromQuery(byScale, "by_scale").select(($) => ({
		bucket: $.bucket,
		groupName: $.groupName,
		bScale: $.bScale,
		gObservations: $.gObservations,
		gSeries: $.gSeries,
		gUncovered: $.gUncovered,
		gMin: $.gMin,
		gMax: $.gMax,
		gZero: $.gZero,
		gPosKeys: $.gPosKeys,
		gPosCounts: $.gPosCounts,
		gNegKeys: $.gNegKeys,
		gNegCounts: $.gNegCounts,
		lowScale: CH.rawExpr(
			"minIf(bScale, arraySum(gPosCounts) + arraySum(gNegCounts) > 0) OVER (PARTITION BY bucket, groupName)",
			T.int32,
		),
	}))

	const mergedAtLowScale = (range: "Pos" | "Neg", element: 1 | 2) =>
		`tupleElement(sumMap(${atLowScale(`g${range}Keys`)}, g${range}Counts), ${element})`
	return fromQuery(rescaled, "rescaled")
		.select(($) => ({
			bucket: $.bucket,
			groupName: $.groupName,
			observations: CH.sum($.gObservations),
			seriesCount: CH.rawExpr("length(groupUniqArrayArray(gSeries))", T.uint64),
			bMin: CH.rawExpr("if(sum(gUncovered) = 0, min(gMin), NULL)", T.nullable(T.float64)),
			bMax: CH.rawExpr("if(sum(gUncovered) = 0, max(gMax), NULL)", T.nullable(T.float64)),
			bLow: CH.any_($.lowScale),
			bZero: CH.sum($.gZero),
			bTotal: CH.sum(CH.rawExpr("arraySum(gPosCounts) + arraySum(gNegCounts) + gZero", T.float64)),
			posKeys: CH.rawExpr(mergedAtLowScale("Pos", 1), T.array(T.int64)),
			posCounts: CH.rawExpr(mergedAtLowScale("Pos", 2), T.array(T.float64)),
			negKeys: CH.rawExpr(mergedAtLowScale("Neg", 1), T.array(T.int64)),
			negCounts: CH.rawExpr(mergedAtLowScale("Neg", 2), T.array(T.float64)),
		}))
		.groupBy("bucket", "groupName")
}

/**
 * Histograms merge their observations across series: every sample is reduced
 * to what it observed since the previous sample of its series, and those
 * increases (count, sum, per-bucket counts) add up within a bucket and group.
 * `avg` is sum over count, the exact distribution average; percentiles are
 * estimated from the merged buckets. `min` and `max` read the recorded extrema,
 * which a cumulative series reports since its start.
 *
 * Exponential histograms take the same path. Their buckets merge at the lowest
 * scale a contributing sample has: a finer bucket lies inside exactly one coarser one.
 */
function histogramTimeseriesQuery(
	opts: MetricsTimeseriesOpts,
	metric: MetricsValueAggregation,
): CHQuery<ColumnDefs, MetricsTimeseriesOutput> {
	const buckets: HistogramBuckets = !isMetricsPercentile(metric)
		? "none"
		: opts.metricType === "exponential_histogram"
			? "exponential"
			: "explicit"
	const samples = histogramSamplesQuery(opts, buckets)

	if (!isMetricsPercentile(metric)) {
		const merged = samples
			.select(($) => ({
				bucket: timeseriesBucket($.TimeUnix, opts.wholeRange),
				groupName: $.groupName,
				observations: CH.sum(CH.rawExpr(OBSERVATIONS, T.float64)),
				total: CH.sum(CH.rawExpr(OBSERVED_SUM, T.float64)),
				minValue: CH.min_($.sMin),
				maxValue: CH.max_($.sMax),
				samples: CH.count(),
				seriesCount: CH.uniqExact($.series),
			}))
			.where(($) => [$.TimeUnix.gte(param.dateTime("startTime"))])
			.groupBy("bucket", "groupName")
		const inner = fromQuery(merged, "merged")
			.select(($) => ({
				bucket: $.bucket,
				groupName: $.groupName,
				value: histogramValueExpr($, metric),
				// A count or sum of zero is a reading as long as the series still exports.
				dataPointCount:
					metric === "count" || metric === "sum" ? $.samples : CH.toUInt64($.observations),
				seriesCount: $.seriesCount,
			}))
			// An average over no observations is not zero; the bucket has no value.
			.where(($) => [metric === "avg" || metric === "latest" ? $.observations.gt(0) : undefined])
			.orderBy(["bucket", "asc"])
		return finalizeTimeseries(inner, metricsTimeseriesColumns, "value", opts)
	}

	const q = METRICS_PERCENTILES[metric]

	const explicitEstimates = () =>
		fromQuery(explicitBucketsMerged(samples, opts), "merged").select(($) => ({
			bucket: $.bucket,
			groupName: $.groupName,
			observations: $.observations,
			seriesCount: $.seriesCount,
			bMin: $.bMin,
			bMax: $.bMax,
			estimate: CH.rawExpr(histogramQuantileSql(q), T.float64),
		}))

	const exponentialEstimates = () => {
		const merged = exponentialBucketsMerged(samples, opts)

		// The walk a percentile takes, in ascending value order.
		const walk = fromQuery(merged, "merged").select(($) => ({
			bucket: $.bucket,
			groupName: $.groupName,
			observations: $.observations,
			seriesCount: $.seriesCount,
			bMin: $.bMin,
			bMax: $.bMax,
			bLow: $.bLow,
			bTotal: $.bTotal,
			wCounts: CH.rawExpr(
				"arrayConcat(arrayReverse(negCounts), [bZero], posCounts)",
				T.array(T.float64),
			),
			wKeys: CH.rawExpr("arrayConcat(arrayReverse(negKeys), [toInt64(0)], posKeys)", T.array(T.int64)),
			wSigns: CH.rawExpr(
				"arrayConcat(arrayWithConstant(length(negKeys), toInt32(-1)), [toInt32(0)], arrayWithConstant(length(posKeys), toInt32(1)))",
				T.array(T.int32),
			),
		}))
		return fromQuery(walk, "walk").select(($) => ({
			bucket: $.bucket,
			groupName: $.groupName,
			observations: $.observations,
			seriesCount: $.seriesCount,
			bMin: $.bMin,
			bMax: $.bMax,
			estimate: CH.rawExpr(exponentialQuantileSql(q), T.float64),
		}))
	}

	const estimated: CHQuery<ColumnDefs, HistogramEstimate, Record<string, ColumnDefs>> = buckets ===
	"exponential"
		? exponentialEstimates()
		: explicitEstimates()
	const inner = fromQuery(estimated, "estimated")
		.select(($) => ({
			bucket: $.bucket,
			groupName: $.groupName,
			// The recorded extrema bound every observation, so they bound the estimate.
			value: CH.least_(
				CH.greatest_($.estimate, CH.ifNull($.bMin, $.estimate)),
				CH.ifNull($.bMax, $.estimate),
			),
			dataPointCount: CH.toUInt64($.observations),
			seriesCount: $.seriesCount,
		}))
		.where(() => [CH.rawCond("isFinite(estimate)")])
		.orderBy(["bucket", "asc"])
	return finalizeTimeseries(inner, metricsTimeseriesColumns, "value", opts)
}

function histogramValueExpr(
	$: {
		readonly observations: CH.Expr<number>
		readonly total: CH.Expr<number>
		readonly minValue: CH.Expr<number | null>
		readonly maxValue: CH.Expr<number | null>
	},
	metric: Exclude<MetricsValueAggregation, MetricsPercentile>,
): CH.Expr<number> {
	switch (metric) {
		case "sum":
			return $.total
		case "min":
			return CH.ifNull($.minValue, CH.lit(0))
		case "max":
			return CH.ifNull($.maxValue, CH.lit(0))
		case "count":
			return $.observations
		case "avg":
		case "latest":
			return finiteOrZero($.total.div($.observations))
	}
}

// Histogram distribution: the merged buckets themselves, for a heatmap

/** The filters a distribution or exemplar read takes: the chart's, without its grouping. */
export type MetricsFilterOpts = Pick<
	MetricsTimeseriesOpts,
	| "metricType"
	| "metricNames"
	| "serviceName"
	| "environments"
	| "attributeFilters"
	| "resourceAttributeFilters"
	| "lookbackSeconds"
>

/**
 * One bucket of one time bucket's merged distribution. `lowerBound` is null for the
 * lowest explicit bucket (it starts at the lowest observation), `upperBound` null for
 * the unbounded last one. Exponential buckets are coarsened to powers of two (scale 0)
 * so a heatmap has a stable, readable value axis.
 */
export interface HistogramDistributionOutput {
	readonly bucket: DateTime.Utc
	readonly lowerBound: number | null
	readonly upperBound: number | null
	readonly count: number
}

// A finite float or NULL: JSON has no infinity.
const finiteOrNull = (expr: string) => `if(isFinite(${expr}), ${expr}, NULL)`

/**
 * The observations in each histogram bucket per time bucket, merged across every
 * series the filters select. Reuses the percentile path's merge, so a cell of the
 * heatmap and the percentile drawn over it count the same observations.
 */
export function histogramDistributionQuery(
	opts: MetricsFilterOpts,
): CHQuery<ColumnDefs, HistogramDistributionOutput> {
	const timeseriesOpts: MetricsTimeseriesOpts = { ...opts }
	const exponential = opts.metricType === "exponential_histogram"
	const samples = histogramSamplesQuery(timeseriesOpts, exponential ? "exponential" : "explicit")

	if (!exponential) {
		// Each sample's buckets under its own edges: two layouts merged by upper bound alone would
		// count a (10, 20] observation in another layout's (15, 20]. Aliases chain in one SELECT.
		const perSample = samples
			.select(($) => ({
				bucket: timeseriesBucket($.TimeUnix, false),
				dInc: CH.rawExpr(BUCKET_COUNTS, T.array(T.float64)),
				dUppers: CH.rawExpr(BUCKET_UPPER_BOUNDS, T.array(T.float64)),
				dIdx: CH.rawExpr("arrayJoin(arrayEnumerate(dInc))", T.uint64),
				dLo: CH.rawExpr("if(dIdx = 1, -inf, bounds[dIdx - 1])", T.float64),
				dUp: CH.rawExpr("dUppers[dIdx]", T.float64),
				dN: CH.rawExpr("dInc[dIdx]", T.float64),
			}))
			// A point without usable buckets (OTLP allows a count with none) has no cell to sit in;
			// it is left out on purpose, as the percentile path leaves it out.
			.where(($) => [$.TimeUnix.gte(param.dateTime("startTime")), CH.rawCond(HAS_BUCKETS)])
		const summed = fromQuery(perSample, "per_sample")
			.select(($) => ({
				bucket: $.bucket,
				dLo: $.dLo,
				dUp: $.dUp,
				dCount: CH.sum($.dN),
			}))
			.groupBy("bucket", "dLo", "dUp")
		return fromQuery(summed, "summed")
			.select(($) => ({
				bucket: $.bucket,
				lowerBound: CH.rawExpr(finiteOrNull("dLo"), T.nullable(T.float64)),
				upperBound: CH.rawExpr(finiteOrNull("dUp"), T.nullable(T.float64)),
				count: $.dCount,
			}))
			.where(($) => [$.dCount.gt(0)])
			.orderBy(["bucket", "asc"])
	}

	// Coarsen to scale 0 (or keep a coarser scale): index k then spans 2^(k*w)..2^((k+1)*w),
	// w = 2^-least(bLow, 0). A negative index shifts by floor, which keeps it in its bucket.
	const shift = "greatest(bLow, 0)"
	const width = "exp2(-least(bLow, 0))"
	const coarse = (range: "pos" | "neg", element: 1 | 2) =>
		`tupleElement(arrayReduce('sumMap', [arrayMap(k -> bitShiftRight(k, ${shift}), ${range}Keys)], [${range}Counts]), ${element})`
	const merged = exponentialBucketsMerged(samples, timeseriesOpts)
	const cells = fromQuery(merged, "merged").select(($) => ({
		bucket: $.bucket,
		dNegKeys: CH.rawExpr(coarse("neg", 1), T.array(T.int64)),
		dNegCounts: CH.rawExpr(coarse("neg", 2), T.array(T.float64)),
		dPosKeys: CH.rawExpr(coarse("pos", 1), T.array(T.int64)),
		dPosCounts: CH.rawExpr(coarse("pos", 2), T.array(T.float64)),
		// Ascending value order: negative buckets far edge first, then zero, then positive.
		dLowers: CH.rawExpr(
			`arrayConcat(arrayReverse(arrayMap(k -> -exp2((k + 1) * ${width}), dNegKeys)), [toFloat64(0)], arrayMap(k -> exp2(k * ${width}), dPosKeys))`,
			T.array(T.float64),
		),
		dUppers: CH.rawExpr(
			`arrayConcat(arrayReverse(arrayMap(k -> -exp2(k * ${width}), dNegKeys)), [toFloat64(0)], arrayMap(k -> exp2((k + 1) * ${width}), dPosKeys))`,
			T.array(T.float64),
		),
		dCounts: CH.rawExpr("arrayConcat(arrayReverse(dNegCounts), [bZero], dPosCounts)", T.array(T.float64)),
		dIdx: CH.rawExpr("arrayJoin(arrayEnumerate(dCounts))", T.uint64),
	}))
	return fromQuery(cells, "cells")
		.select(($) => ({
			bucket: $.bucket,
			lowerBound: CH.rawExpr(finiteOrNull("dLowers[dIdx]"), T.nullable(T.float64)),
			upperBound: CH.rawExpr(finiteOrNull("dUppers[dIdx]"), T.nullable(T.float64)),
			count: CH.rawExpr("dCounts[dIdx]", T.float64),
		}))
		.where(() => [CH.rawCond("dCounts[dIdx] > 0")])
		.orderBy(["bucket", "asc"])
}

// Exemplars: the traces behind a metric's datapoints

export interface MetricExemplarsOpts extends MetricsFilterOpts {
	/** Kept per time bucket, highest value first, so one busy minute cannot crowd out the rest. */
	readonly perBucket?: number
	readonly limit?: number
	/**
	 * One heatmap cell: its time bucket (the `cellBucket` param) and value range, (lower, upper];
	 * a null edge is open, and 0 to 0 is the zero bucket.
	 */
	readonly cell?: { readonly lowerBound: number | null; readonly upperBound: number | null }
}

export const METRIC_EXEMPLARS_PER_BUCKET = 3
export const METRIC_EXEMPLARS_LIMIT = 500

const cellConditions = (
	$: { readonly bucket: CH.Expr<DateTime.Utc>; readonly value: CH.Expr<number> },
	cell: MetricExemplarsOpts["cell"],
	metricType: MetricType,
): ReadonlyArray<CH.Condition | undefined> => {
	if (cell === undefined) return []
	const inBucket = $.bucket.eq(param.dateTime("cellBucket"))
	if (cell.lowerBound === 0 && cell.upperBound === 0) return [inBucket, $.value.eq(0)]
	// OTel buckets magnitudes as (a, b], so a negative exponential range mirrors to [-b, -a).
	const mirrored = metricType === "exponential_histogram" && cell.upperBound !== null && cell.upperBound < 0
	return [
		inBucket,
		cell.lowerBound === null
			? undefined
			: mirrored
				? $.value.gte(cell.lowerBound)
				: $.value.gt(cell.lowerBound),
		cell.upperBound === null
			? undefined
			: mirrored
				? $.value.lt(cell.upperBound)
				: $.value.lte(cell.upperBound),
	]
}

/**
 * The exemplars recorded on a metric's datapoints in range: the trace and span an SDK
 * sampled while recording the value. Bucketed by the datapoint's export time, as the
 * distribution is, so a heatmap cell and its exemplars agree. Each time bucket keeps its
 * highest values, which is what a latency spike needs explained.
 */
export function metricExemplarsQuery(opts: MetricExemplarsOpts) {
	const { tbl } = resolveMetricTable(opts.metricType)
	const timeseriesOpts: MetricsTimeseriesOpts = { ...opts }
	// Read the bucket before the window too, as the distribution reads its predecessors: an
	// exemplar already exported there is a repeat, not a new one at the window's start.
	const scanStart = CH.intervalSub(
		param.dateTime("startTime"),
		opts.lookbackSeconds ?? param.int("bucketSeconds"),
	)
	const unrolled = from(tbl as typeof Datasources.metricsHistogram)
		.select(($) => ({
			exportedAt: $.TimeUnix,
			bucket: timeseriesBucket($.TimeUnix, false),
			serviceName: $.ServiceName,
			eIdx: CH.rawExpr("arrayJoin(arrayEnumerate(ExemplarsTraceId))", T.uint64),
			timestamp: CH.rawExpr("ExemplarsTimestamp[eIdx]", T.dateTime64),
			value: CH.rawExpr("ExemplarsValue[eIdx]", T.float64),
			traceId: CH.rawExpr("ExemplarsTraceId[eIdx]", T.string),
			spanId: CH.rawExpr("ExemplarsSpanId[eIdx]", T.string),
		}))
		// An exemplar without a trace id links nowhere; a non-finite value has no place on a chart.
		.where(($) => [
			...metricsWhere($, timeseriesOpts, scanStart),
			CH.rawCond("notEmpty(ExemplarsTraceId) AND traceId != '' AND isFinite(value)"),
		])
	// A cumulative reservoir or a scrape repeats one exemplar on every datapoint: the same
	// observation (trace, span, time, value) is listed once, in the bucket it was first exported in.
	const distinct = fromQuery(unrolled, "unrolled")
		.select(($) => ({
			firstExportedAt: CH.min_($.exportedAt),
			bucket: CH.min_($.bucket),
			timestamp: $.timestamp,
			value: $.value,
			traceId: $.traceId,
			spanId: $.spanId,
			serviceName: CH.any_($.serviceName),
		}))
		.groupBy("traceId", "spanId", "timestamp", "value")
	const ranked = fromQuery(distinct, "distinct_exemplars")
		.select(($) => ({
			bucket: $.bucket,
			timestamp: $.timestamp,
			value: $.value,
			traceId: $.traceId,
			spanId: $.spanId,
			serviceName: $.serviceName,
			exemplarRank: CH.rawExpr("row_number() OVER (PARTITION BY bucket ORDER BY value DESC)", T.uint64),
		}))
		.where(($) => [
			$.firstExportedAt.gte(param.dateTime("startTime")),
			...cellConditions($, opts.cell, opts.metricType),
		])
	// The cap takes every bucket's top exemplar before any bucket's second, so a wide window
	// keeps a dot on each bucket; the rows then read highest first.
	const kept = fromQuery(ranked, "ranked")
		.select(($) => ({
			bucket: $.bucket,
			timestamp: $.timestamp,
			value: $.value,
			traceId: $.traceId,
			spanId: $.spanId,
			serviceName: $.serviceName,
			exemplarRank: $.exemplarRank,
		}))
		.where(($) => [$.exemplarRank.lte(opts.perBucket ?? METRIC_EXEMPLARS_PER_BUCKET)])
		.orderBy(["exemplarRank", "asc"], ["value", "desc"])
		.limit(opts.limit ?? METRIC_EXEMPLARS_LIMIT)
	return fromQuery(kept, "kept")
		.select(($) => ({
			bucket: $.bucket,
			timestamp: $.timestamp,
			value: $.value,
			traceId: $.traceId,
			spanId: $.spanId,
			serviceName: $.serviceName,
		}))
		.orderBy(["value", "desc"])
}

// Rate/increase timeseries — raw SQL (requires CTE)

export interface MetricsRateTimeseriesOpts {
	/** Per-second rate or the bucket's increase. Default: rate. */
	metric?: "rate" | "increase"
	/** How the series of one group combine. Default: sum. */
	spaceAggregation?: MetricsSpaceAggregation
	metricName?: string
	// Candidate names matched with `MetricName IN (...)`. When provided (and
	// non-empty) it replaces the scalar `metricName` equality in the WHERE clause,
	// so a metric with one of a few known spellings resolves in a single query.
	metricNames?: ReadonlyArray<string>
	/** Source table: `gauge` reads metrics_gauge (Prometheus counters often land there). Default `sum`. */
	metricType?: MetricType
	bucketSeconds?: number
	/** How far before startTime to read for each series' previous sample. Default: bucketSeconds. */
	lookbackSeconds?: number
	/** One bucket per group over the whole range; see `timeseriesBucket`. Alert evaluation sets it. */
	wholeRange?: boolean
	serviceName?: string
	/** Deployment environments to scope to. Empty/undefined means all. */
	environments?: readonly string[]
	groupByAttributeKey?: string
	/** Group by a ResourceAttributes key instead of a datapoint Attributes key. */
	groupByResourceAttributeKey?: string
	groupByAttributeKeys?: readonly string[]
	groupByResourceAttributeKeys?: readonly string[]
	/** Predicates on the datapoint Attributes map (metric labels). */
	attributeFilters?: readonly AttributeFilter[]
	resourceAttributeFilters?: readonly AttributeFilter[]
	groupBy?: readonly string[]
	seriesLimit?: number
}

// Must stay in sync with the WHERE clause of `span_metrics_calls_hourly_mv`.
// `traces.span.metrics.calls` is what the collector emits in practice
// (spanmetricsconnector output is namespaced by its pipeline); it was missing
// from both sides, so the rollup held 0 rows and every read took the raw path.
const SPAN_METRICS_CALLS_NAMES = new Set(["span.metrics.calls", "calls", "traces.span.metrics.calls"])

// The value of a lone, plain `span.kind = X` filter, else undefined.
function spanKindEqualsValue(filters: readonly AttributeFilter[] | undefined): string | undefined {
	const [only, ...rest] = filters ?? []
	if (only === undefined || rest.length > 0) return undefined
	return only.key === "span.kind" &&
		only.mode === "equals" &&
		!only.negated &&
		(only.or === undefined || only.or.length === 0)
		? only.value
		: undefined
}

function canUseSpanMetricsCallsHourly(opts: MetricsRateTimeseriesOpts): boolean {
	return (
		// Hour-grain rows cannot be cut to a sliding window.
		!opts.wholeRange &&
		// The hourly MV is keyed by a single MetricName; an `IN (...)` candidate set
		// can't be served from it, so fall back to the raw path. The interactive UI
		// (sub-hour buckets) never qualifies for this fast path anyway.
		(opts.metricNames === undefined || opts.metricNames.length <= 1) &&
		opts.metricName !== undefined &&
		SPAN_METRICS_CALLS_NAMES.has(opts.metricName) &&
		opts.bucketSeconds !== undefined &&
		opts.bucketSeconds >= 3600 &&
		opts.bucketSeconds % 3600 === 0 &&
		(opts.spaceAggregation === undefined || opts.spaceAggregation === "sum") &&
		(opts.groupByAttributeKey === undefined || opts.groupByAttributeKey === "span.kind") &&
		(opts.groupByAttributeKeys === undefined ||
			(opts.groupByAttributeKeys.length <= 1 &&
				(opts.groupByAttributeKeys[0] ?? "span.kind") === "span.kind")) &&
		(opts.groupByResourceAttributeKeys === undefined || opts.groupByResourceAttributeKeys.length === 0) &&
		// The hourly MV keeps only SpanKind of the datapoint labels.
		(opts.attributeFilters === undefined ||
			opts.attributeFilters.length === 0 ||
			spanKindEqualsValue(opts.attributeFilters) !== undefined) &&
		// The hourly MV folds ResourceAttributes into a fingerprint — it cannot
		// serve resource-attribute filters or group-bys, and `deployment.environment`
		// lives in that same map, so an environment filter also drops to the raw path.
		opts.groupByResourceAttributeKey === undefined &&
		(opts.resourceAttributeFilters === undefined || opts.resourceAttributeFilters.length === 0) &&
		(opts.environments === undefined || opts.environments.length === 0)
	)
}

function metricsTimeseriesRateFromSpanMetricsCallsHourly(
	opts: MetricsRateTimeseriesOpts,
): CHQuery<ColumnDefs, MetricsTimeseriesOutput> {
	const bucket = CH.toStartOfInterval(
		CH.toDateTime(utcSecondsParam("startTime")),
		param.int("bucketSeconds"),
	)
	const previousBucket = CH.intervalSub(bucket, param.int("bucketSeconds"))
	const endBucket = CH.toStartOfInterval(
		CH.toDateTime(utcSecondsParam("endTime")),
		param.int("bucketSeconds"),
	)
	// The same bounds for the CTE columns below, which decode as `DateTime.Utc`.
	const bucketUtc = CH.toStartOfInterval(
		CH.toDateTime(utcSecondsParam("startTime")),
		param.int("bucketSeconds"),
	)
	const endBucketUtc = CH.toStartOfInterval(
		CH.toDateTime(utcSecondsParam("endTime")),
		param.int("bucketSeconds"),
	)

	const hourlyQuery = from(Datasources.spanMetricsCallsHourly)
		.select(($) => ({
			Hour: $.Hour,
			ServiceName: $.ServiceName,
			MetricName: $.MetricName,
			SpanKind: $.SpanKind,
			AttrFingerprint: $.AttrFingerprint,
			ResourceFingerprint: $.ResourceFingerprint,
			StartTimeUnix: $.StartTimeUnix,
			Value: CH.argMaxMerge($.LastValue),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.MetricName.eq(param.string("metricName")),
			$.Hour.gte(previousBucket),
			$.Hour.lte(endBucket),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(spanKindEqualsValue(opts.attributeFilters), (v: string) => $.SpanKind.eq(v)),
		])
		.groupBy(
			"Hour",
			"ServiceName",
			"MetricName",
			"SpanKind",
			"AttrFingerprint",
			"ResourceFingerprint",
			"StartTimeUnix",
		)

	const hourlyValues = table("hourly_values", {
		external: true,
		columns: {
			Hour: T.dateTime,
			ServiceName: T.string,
			MetricName: T.string,
			SpanKind: T.string,
			AttrFingerprint: T.uint64,
			ResourceFingerprint: T.uint64,
			StartTimeUnix: T.dateTime64,
			Value: T.float64,
		},
	})

	const deltasQuery = from(hourlyValues)
		.select(($) => {
			const onePrecedingFrame = CH.windowSpec({
				partitionBy: [
					$.ServiceName,
					$.MetricName,
					$.SpanKind,
					$.AttrFingerprint,
					$.ResourceFingerprint,
					$.StartTimeUnix,
				],
				orderBy: [[$.Hour, "asc"]],
				frame: CH.rowsBetween(CH.preceding(1), CH.currentRow),
			})

			return {
				Hour: $.Hour,
				ServiceName: $.ServiceName,
				SpanKind: $.SpanKind,
				series: CH.cityHash64($.ServiceName, $.SpanKind, $.AttrFingerprint, $.ResourceFingerprint),
				delta: $.Value.sub(CH.over(CH.lagInFrame($.Value, 1, $.Value), onePrecedingFrame)),
			}
		})
		.where(($) => [$.Hour.gte(bucketUtc)])

	const deltas = table("with_deltas", {
		external: true,
		columns: {
			Hour: T.dateTime,
			ServiceName: T.string,
			SpanKind: T.string,
			series: T.uint64,
			delta: T.float64,
		},
	})

	const q = from(deltas)
		// Passed as queries, not compiled SQL: `compile` then derives each CTE's
		// scope (and `with_deltas` inherits `hourly_values`'s, which is what
		// confines the outer query) instead of taking a caller's word for it.
		.withCTE("hourly_values", hourlyQuery)
		.withCTE("with_deltas", deltasQuery)
		.select(($) => {
			const parts: CH.Expr<string>[] = []
			for (const dim of opts.groupBy ?? []) {
				if (dim === "service") parts.push($.ServiceName)
				else if (dim === "attribute") parts.push($.SpanKind)
			}
			const groupName =
				parts.length === 0
					? CH.lit("")
					: parts.length === 1 && parts[0] !== undefined
						? parts[0]
						: CH.arrayStringConcat(
								CH.arrayFilter("x -> x != ''", CH.arrayOf(...parts)),
								" \u00b7 ",
							)
			const increase = CH.sumIf($.delta, $.delta.gte(0))
			return {
				bucket: CH.toStartOfInterval($.Hour, param.int("bucketSeconds")),
				groupName,
				value:
					(opts.metric ?? "rate") === "rate"
						? finiteOrZero(increase.div(param.int("bucketSeconds")))
						: increase,
				dataPointCount: CH.count(),
				seriesCount: CH.uniqExact($.series),
			}
		})
		.where(($) => [$.Hour.gte(bucketUtc), $.Hour.lte(endBucketUtc)])

	const inner = q.groupBy("bucket", "groupName").orderBy(["bucket", "asc"])

	return finalizeTimeseries(inner, metricsTimeseriesColumns, "value", opts)
}

/**
 * Per-sample increment of one counter series, given the previous sample of the
 * same series (`lagInFrame` defaults to the current row, so a series' first
 * sample yields 0 instead of its lifetime total).
 *
 * - delta temporality: the sample already is the increment.
 * - value dropped: the counter reset; the new value is what accrued since.
 * - StartTimeUnix moved past the previous sample (a restart that has already
 *   counted back above the old value): also a reset. `startTime < time` skips
 *   exporters that stamp StartTimeUnix = TimeUnix on every point.
 */
export function metricDeltaExpr(args: {
	readonly value: CH.Expr<number>
	readonly previousValue: CH.Expr<number>
	readonly startTime: CH.Expr<DateTime.Utc>
	readonly previousTime: CH.Expr<DateTime.Utc>
	readonly time: CH.Expr<DateTime.Utc>
	readonly isDeltaTemporality?: CH.Condition
}): CH.Expr<number> {
	const restarted = args.startTime.gt(args.previousTime).and(args.startTime.lt(args.time))
	const cases: Array<[CH.Condition, CH.Expr<number>]> = []
	if (args.isDeltaTemporality) cases.push([args.isDeltaTemporality, args.value])
	cases.push([args.value.lt(args.previousValue), args.value], [restarted, args.value])
	return CH.multiIf(cases, args.value.sub(args.previousValue))
}

export function metricsTimeseriesRateQuery(
	opts: MetricsRateTimeseriesOpts,
): CHQuery<ColumnDefs, MetricsTimeseriesOutput> {
	if (canUseSpanMetricsCallsHourly(opts)) return metricsTimeseriesRateFromSpanMetricsCallsHourly(opts)

	// Prometheus-style counters often land as gauges (or as sums flagged
	// non-monotonic), so the source table follows `metricType` and IsMonotonic
	// is not a filter: the reset-aware delta below is what makes it a counter.
	const isGauge = opts.metricType === "gauge"
	const tbl = isGauge ? Datasources.metricsGauge : Datasources.metricsSum

	// One partition per emitting series: datapoint labels plus the resource
	// (pod, instance, environment). The Maps are folded into `cityHash64`
	// fingerprints because sorting by raw Maps dominated the query cost.
	// StartTimeUnix is deliberately NOT in the key: a restart must stay in the
	// same partition so `metricDeltaExpr` can see it and count the new value.
	const cteQuery = from(tbl as typeof Datasources.metricsSum)
		.select(($) => {
			const onePrecedingFrame = CH.windowSpec({
				partitionBy: [
					$.ServiceName,
					$.MetricName,
					CH.cityHash64(CH.mapKeys($.Attributes), CH.mapValues($.Attributes)),
					CH.cityHash64(CH.mapKeys($.ResourceAttributes), CH.mapValues($.ResourceAttributes)),
				],
				orderBy: [[$.TimeUnix, "asc"]],
				frame: CH.rowsBetween(CH.preceding(1), CH.currentRow),
			})
			return {
				TimeUnix: $.TimeUnix,
				groupName: metricsGroupNameExpr($, opts),
				series: metricsSeriesKeyExpr($),
				delta: metricDeltaExpr({
					value: $.Value,
					previousValue: CH.over(CH.lagInFrame($.Value, 1, $.Value), onePrecedingFrame),
					startTime: $.StartTimeUnix,
					previousTime: CH.over(CH.lagInFrame($.TimeUnix, 1, $.TimeUnix), onePrecedingFrame),
					time: $.TimeUnix,
					isDeltaTemporality: isGauge
						? undefined
						: CH.dynamicColumn<number>("AggregationTemporality").eq(1),
				}),
			}
		})
		.where(($) => [
			opts.metricNames && opts.metricNames.length > 0
				? $.MetricName.in_(...opts.metricNames)
				: $.MetricName.eq(param.string("metricName")),
			$.OrgId.eq(orgIdParam),
			$.TimeUnix.gte(
				CH.intervalSub(
					param.dateTime("startTime"),
					opts.lookbackSeconds ?? param.int("bucketSeconds"),
				),
			),
			$.TimeUnix.lte(param.dateTime("endTime")),
			wholeRangeEnd($.TimeUnix, opts.wholeRange),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			opts.environments !== undefined && opts.environments.length > 0
				? CH.inList(deploymentEnvExpr($.ResourceAttributes), opts.environments)
				: undefined,
			...datapointFilterConditions(opts.attributeFilters),
			...resourceFilterConditions(opts.resourceAttributeFilters),
		])

	const cteTable = table("with_deltas", {
		external: true,
		columns: {
			TimeUnix: T.dateTime64,
			groupName: T.string,
			series: T.uint64,
			delta: T.float64,
		},
	})

	// Each series' increase per bucket, then the series of a group combined.
	const perSeries = from(cteTable)
		.withCTE("with_deltas", cteQuery)
		.select(($) => ({
			bucket: timeseriesBucket($.TimeUnix, opts.wholeRange),
			groupName: $.groupName,
			series: $.series,
			increase: CH.sum($.delta),
			points: CH.count(),
		}))
		.where(($) => [$.TimeUnix.gte(param.dateTime("startTime"))])
		.groupBy("bucket", "groupName", "series")

	const inner = fromQuery(perSeries, "per_series")
		.select(($) => {
			// Seconds of the bucket inside [startTime, endTime]: the edge buckets are
			// partial, and dividing them by the full width understates their rate.
			// A `wholeRange` bucket is the whole range, whatever width the spec stored.
			const bucketStart = CH.toUnixTimestamp($.bucket)
			const rangeStart = CH.toUnixTimestamp(CH.toDateTime(utcSecondsParam("startTime")))
			const rangeEnd = CH.toUnixTimestamp(CH.toDateTime(utcSecondsParam("endTime")))
			const coveredSeconds = opts.wholeRange
				? rangeEnd.sub(rangeStart)
				: CH.least_(bucketStart.add(param.int("bucketSeconds")), rangeEnd).sub(
						CH.greatest_(bucketStart, rangeStart),
					)
			const combined = spaceAggregationExpr($.increase, opts.spaceAggregation ?? "sum")
			return {
				bucket: $.bucket,
				groupName: $.groupName,
				// A series' rate is its increase over the covered width; the width is
				// one per bucket, so combining increases first is the same number.
				value:
					(opts.metric ?? "rate") === "rate" && opts.spaceAggregation !== "count"
						? finiteOrZero(combined.div(CH.min_(coveredSeconds)))
						: combined,
				dataPointCount: CH.sum($.points),
				seriesCount: CH.count(),
			}
		})
		.groupBy("bucket", "groupName")
		.orderBy(["bucket", "asc"])

	return finalizeTimeseries(inner, metricsTimeseriesColumns, "value", opts)
}

export interface MetricsSparklinesOpts {
	metricType: MetricType
	/** Matched with `MetricName IN (...)` — one query covers a whole grid page. */
	metricNames: ReadonlyArray<string>
}

/** One metric's bucket. A histogram's values are what the bucket observed; it has no row for a bucket that observed nothing. */
export interface MetricsSparklinesOutput {
	readonly bucket: DateTime.Utc
	readonly metricName: string
	readonly avgValue: number
	readonly sumValue: number
	readonly dataPointCount: number
}

export function metricsSparklinesQuery(
	opts: MetricsSparklinesOpts,
): CHQuery<ColumnDefs, MetricsSparklinesOutput> {
	const { tbl, isHistogram } = resolveMetricTable(opts.metricType)

	if (isHistogram) {
		const scanStart = CH.intervalSub(param.dateTime("startTime"), param.int("bucketSeconds"))
		const samplesQuery = from(tbl as typeof Datasources.metricsHistogram)
			.select(($) => histogramSampleSelect($, { groupName: $.MetricName, scanStart, buckets: "none" }))
			.where(($) => [
				$.MetricName.in_(...opts.metricNames),
				$.OrgId.eq(orgIdParam),
				$.TimeUnix.gte(scanStart),
				$.TimeUnix.lte(param.dateTime("endTime")),
				HAS_RECORDED_VALUE,
			])
		const merged = from(histogramSamples)
			.withCTE("hist_samples", samplesQuery)
			.select(($) => ({
				bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
				metricName: $.groupName,
				observations: CH.sum(CH.rawExpr(OBSERVATIONS, T.float64)),
				total: CH.sum(CH.rawExpr(OBSERVED_SUM, T.float64)),
			}))
			.where(($) => [$.TimeUnix.gte(param.dateTime("startTime"))])
			.groupBy("bucket", "metricName")
		return fromQuery(merged, "merged")
			.select(($) => ({
				bucket: $.bucket,
				metricName: $.metricName,
				avgValue: finiteOrZero($.total.div($.observations)),
				sumValue: $.total,
				dataPointCount: CH.toUInt64($.observations),
			}))
			.where(($) => [$.observations.gt(0)])
			.orderBy(["bucket", "asc"])
			.format("JSON")
	}

	return from(tbl as typeof Datasources.metricsSum)
		.select(($) => {
			const exprs = metricsSelectExprs($)
			return {
				bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
				metricName: $.MetricName,
				avgValue: exprs.avgValue,
				sumValue: exprs.sumValue,
				dataPointCount: exprs.dataPointCount,
			}
		})
		.where(($) => [
			$.MetricName.in_(...opts.metricNames),
			$.OrgId.eq(orgIdParam),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("bucket", "metricName")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

export interface MetricsBreakdownOpts {
	metricType: MetricType
	groupByAttributeKey?: string
	/** Break down by a ResourceAttributes key instead of a datapoint Attributes key. */
	groupByResourceAttributeKey?: string
	resourceAttributeFilters?: readonly AttributeFilter[]
	serviceName?: string
	environments?: readonly string[]
	/** Predicates on the datapoint Attributes map (metric labels). */
	attributeFilters?: readonly AttributeFilter[]
	/** Aggregate that ranks groups before `limit` applies. Default: count. */
	rankBy?: "avg" | "sum" | "min" | "max" | "count"
	limit?: number
	/**
	 * Histograms only: how far before startTime to read each series' previous sample.
	 * Pass the chart's bucket width to read exactly the samples the chart reads.
	 */
	lookbackSeconds?: number
}

// Previous-sample lookback of a histogram breakdown; 10 minutes covers common export intervals.
const BREAKDOWN_LOOKBACK_SECONDS = 600

const BREAKDOWN_RANK_COLUMN = {
	avg: "avgValue",
	sum: "sumValue",
	min: "minValue",
	max: "maxValue",
	count: "count",
} as const

/** One group over the range. A histogram's values are what the range observed; a group that observed nothing has no row. */
export interface MetricsBreakdownOutput {
	readonly name: string
	readonly avgValue: number
	readonly minValue: number
	readonly maxValue: number
	readonly sumValue: number
	readonly count: number
}

export function metricsBreakdownQuery(
	opts: MetricsBreakdownOpts,
): CHQuery<ColumnDefs, MetricsBreakdownOutput> {
	const { tbl, isHistogram } = resolveMetricTable(opts.metricType)
	const limit = opts.limit ?? 10
	const groupKey = opts.groupByAttributeKey
	const resourceGroupKey = opts.groupByResourceAttributeKey
	const rankColumn = BREAKDOWN_RANK_COLUMN[opts.rankBy ?? "count"]

	// Break down by a resource attribute or metric label value when requested, otherwise by service.
	const nameOf = ($: Pick<MetricsRow, "ServiceName" | "Attributes" | "ResourceAttributes">) =>
		resourceGroupKey
			? $.ResourceAttributes.get(resourceGroupKey)
			: groupKey
				? $.Attributes.get(groupKey)
				: $.ServiceName
	const rowFilters = (
		$: Pick<MetricsRow, "MetricName" | "OrgId" | "ServiceName" | "Attributes" | "ResourceAttributes">,
	) => [
		$.MetricName.eq(param.string("metricName")),
		$.OrgId.eq(orgIdParam),
		// Drop datapoints missing the label so an empty bucket doesn't dominate.
		CH.when(groupKey, (k: string) => $.Attributes.get(k).neq("")),
		CH.when(resourceGroupKey, (k: string) => $.ResourceAttributes.get(k).neq("")),
		CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		opts.environments !== undefined && opts.environments.length > 0
			? CH.inList(deploymentEnvExpr($.ResourceAttributes), opts.environments)
			: undefined,
		...datapointFilterConditions(opts.attributeFilters),
		...resourceFilterConditions(opts.resourceAttributeFilters),
	]

	if (isHistogram) {
		const scanStart = CH.intervalSub(
			param.dateTime("startTime"),
			opts.lookbackSeconds ?? BREAKDOWN_LOOKBACK_SECONDS,
		)
		const samplesQuery = from(tbl as typeof Datasources.metricsHistogram)
			.select(($) => histogramSampleSelect($, { groupName: nameOf($), scanStart, buckets: "none" }))
			.where(($) => [
				...rowFilters($),
				$.TimeUnix.gte(scanStart),
				$.TimeUnix.lte(param.dateTime("endTime")),
				HAS_RECORDED_VALUE,
			])
		const merged = from(histogramSamples)
			.withCTE("hist_samples", samplesQuery)
			.select(($) => ({
				name: $.groupName,
				observations: CH.sum(CH.rawExpr(OBSERVATIONS, T.float64)),
				total: CH.sum(CH.rawExpr(OBSERVED_SUM, T.float64)),
				// Min and Max are Nullable: a histogram may record no extrema.
				minValue: CH.ifNull(CH.min_($.sMin), CH.lit(0)),
				maxValue: CH.ifNull(CH.max_($.sMax), CH.lit(0)),
			}))
			.where(($) => [$.TimeUnix.gte(param.dateTime("startTime"))])
			.groupBy("name")
		return fromQuery(merged, "merged")
			.select(($) => ({
				name: $.name,
				avgValue: finiteOrZero($.total.div($.observations)),
				minValue: $.minValue,
				maxValue: $.maxValue,
				sumValue: $.total,
				count: CH.toUInt64($.observations),
			}))
			.where(($) => [$.observations.gt(0)])
			.orderBy([rankColumn, "desc"])
			.limit(limit)
			.format("JSON")
	}

	return from(tbl as typeof Datasources.metricsSum)
		.select(($) => {
			const exprs = metricsSelectExprs($)
			return {
				name: nameOf($),
				avgValue: exprs.avgValue,
				minValue: exprs.minValue,
				maxValue: exprs.maxValue,
				sumValue: exprs.sumValue,
				count: exprs.dataPointCount,
			}
		})
		.where(($) => [
			...rowFilters($),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("name")
		.orderBy([rankColumn, "desc"])
		.limit(limit)
		.format("JSON")
}

export interface ListMetricsOpts {
	serviceName?: string
	metricType?: string
	search?: string
	/** One metric by its exact name, whatever else shares its spelling. */
	exactName?: string
	limit?: number
	offset?: number
}

export interface ListMetricsOutput {
	readonly metricName: string
	readonly metricType: string
	readonly serviceName: string
	readonly metricDescription: string
	readonly metricUnit: string
	readonly dataPointCount: number
	readonly firstSeen: DateTime.Utc
	readonly lastSeen: DateTime.Utc
	readonly isMonotonic: boolean | number
}

export function listMetricsQuery(opts: ListMetricsOpts) {
	return from(Datasources.metricCatalog)
		.select(($) => ({
			metricName: $.MetricName,
			metricType: $.MetricType,
			serviceName: $.ServiceName,
			metricDescription: CH.any_($.MetricDescription),
			metricUnit: CH.any_($.MetricUnit),
			dataPointCount: CH.sum($.DataPointCount),
			firstSeen: CH.min_($.FirstSeen),
			lastSeen: CH.max_($.LastSeen),
			isMonotonic: CH.any_($.IsMonotonic),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			// Floor the start bound to the hour so the oldest catalog bucket
			// (Hour is already hour-truncated) isn't dropped for mid-hour ranges.
			$.Hour.gte(CH.toStartOfInterval(CH.toDateTime(utcSecondsParam("startTime")), 3600)),
			$.Hour.lte(utcSecondsParam("endTime")),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.metricType, (v: string) => $.MetricType.eq(v)),
			CH.when(opts.search, (v: string) => $.MetricName.ilike(`%${v}%`)),
			CH.when(opts.exactName, (v: string) => $.MetricName.eq(v)),
		])
		.groupBy("metricName", "metricType", "serviceName")
		.orderBy(["lastSeen", "desc"], ["metricName", "asc"], ["metricType", "asc"], ["serviceName", "asc"])
		.limit(opts.limit ?? 100)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

export interface MetricsSummaryOutput {
	readonly metricType: string
	readonly metricCount: number
	readonly dataPointCount: number
}

export interface MetricsSummaryOpts {
	serviceName?: string
}

export function metricsSummaryQuery(opts?: MetricsSummaryOpts) {
	return from(Datasources.metricCatalog)
		.select(($) => ({
			metricType: $.MetricType,
			metricCount: CH.uniq($.MetricName),
			dataPointCount: CH.sum($.DataPointCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Hour.gte(CH.toStartOfInterval(CH.toDateTime(utcSecondsParam("startTime")), 3600)),
			$.Hour.lte(utcSecondsParam("endTime")),
			CH.when(opts?.serviceName, (v: string) => $.ServiceName.eq(v)),
		])
		.groupBy("metricType")
		.format("JSON")
}
