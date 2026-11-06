// Typed Metrics Queries
//
// DSL-based query definitions for metrics timeseries, breakdown, and
// a raw-SQL builder for counter rate/increase (which requires CTEs).

import type { DateTime } from "effect"
import { finiteOrZero } from "./format"
import {
	defaultSpaceAggregation,
	type AttributeFilter,
	type MetricsMetric,
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
import {
	MetricsSum,
	MetricsGauge,
	MetricsHistogram,
	MetricCatalog,
	SpanMetricsCallsHourly,
	orgIdParam,
	utcSecondsParam,
} from "../tables"
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

// Shared options & output types

/** Time aggregations the value tables take; `rate`/`increase` go through `metricsTimeseriesRateQuery`. */
export type MetricsValueAggregation = Exclude<MetricsMetric, "rate" | "increase">

interface MetricsQueryOpts {
	metricType: MetricType
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
}

/** One group's value in one bucket. `groupName` is "" when the query has no group-by. */
export interface MetricsTimeseriesOutput {
	readonly bucket: DateTime.Utc
	readonly groupName: string
	readonly value: number
	/** Datapoints behind the value (observations for histograms). */
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

type MetricsRow = ColumnAccessor<typeof MetricsSum.columns>

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
	ColumnAccessor<typeof MetricsSum.columns> | ColumnAccessor<typeof MetricsHistogram.columns>,
	"MetricName" | "OrgId" | "TimeUnix" | "ServiceName" | "Attributes" | "ResourceAttributes"
>

function metricsWhere($: MetricsWhereColumns, opts: MetricsTimeseriesOpts) {
	return [
		$.MetricName.eq(param.string("metricName")),
		$.OrgId.eq(orgIdParam),
		$.TimeUnix.gte(param.dateTime("startTime")),
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

// Timeseries query — two stages for sum/gauge, bucket merge for histograms

/**
 * Sum and gauge rows reduce in two stages, the model every metrics backend
 * uses: each series is reduced within the bucket (`metric`), then the series of
 * a group are combined (`spaceAggregation`). One stage would weight a series by
 * how often it reports: `sum` of a gauge scraped 4x per bucket read 4x high.
 *
 * Histograms merge their observations across series instead (sum of Sum over
 * sum of Count), which is the exact distribution average; `spaceAggregation`
 * does not apply to them.
 */
export function metricsTimeseriesQuery(opts: MetricsTimeseriesOpts) {
	const metric = opts.metric ?? "avg"
	const { tbl, isHistogram } = resolveMetricTable(opts.metricType)

	if (isHistogram) {
		const inner = from(tbl as typeof MetricsHistogram)
			.select(($) => ({
				bucket: timeseriesBucket($.TimeUnix, opts.wholeRange),
				groupName: metricsGroupNameExpr($, opts),
				value: histogramValueExpr($, metric),
				dataPointCount: CH.sum($.Count),
				seriesCount: CH.uniqExact(metricsSeriesKeyExpr($)),
			}))
			.where(($) => metricsWhere($, opts))
			.groupBy("bucket", "groupName")
			.orderBy(["bucket", "asc"])
		return finalizeTimeseries(inner, metricsTimeseriesColumns, "value", opts)
	}

	const perSeries = from(tbl as typeof MetricsSum)
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

function histogramValueExpr(
	$: ColumnAccessor<typeof MetricsHistogram.columns>,
	metric: MetricsValueAggregation,
): CH.Expr<number> {
	switch (metric) {
		case "sum":
			return CH.sum($.Sum)
		case "min":
			return CH.ifNull(CH.min_($.Min), CH.lit(0))
		case "max":
			return CH.ifNull(CH.max_($.Max), CH.lit(0))
		case "count":
			return CH.toFloat64(CH.sum($.Count))
		case "avg":
		case "latest":
			return finiteOrZero(CH.sum($.Sum).div(CH.sum($.Count)))
	}
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

	const hourlyQuery = from(SpanMetricsCallsHourly)
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
	const tbl = isGauge ? MetricsGauge : MetricsSum

	// One partition per emitting series: datapoint labels plus the resource
	// (pod, instance, environment). The Maps are folded into `cityHash64`
	// fingerprints because sorting by raw Maps dominated the query cost.
	// StartTimeUnix is deliberately NOT in the key: a restart must stay in the
	// same partition so `metricDeltaExpr` can see it and count the new value.
	const cteQuery = from(tbl as typeof MetricsSum)
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

// Sparklines query — batched preview series for the metrics browse grid

export interface MetricsSparklinesOpts {
	metricType: MetricType
	/** Matched with `MetricName IN (...)` — one query covers a whole grid page. */
	metricNames: ReadonlyArray<string>
}

export interface MetricsSparklinesOutput {
	readonly bucket: DateTime.Utc
	readonly metricName: string
	readonly avgValue: number
	readonly sumValue: number
	readonly dataPointCount: number
}

export function metricsSparklinesQuery(opts: MetricsSparklinesOpts) {
	const { tbl, isHistogram } = resolveMetricTable(opts.metricType)

	return from(tbl as typeof MetricsSum)
		.select(($) => {
			const exprs = metricsSelectExprs($, isHistogram)
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

// Breakdown query

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
}

const BREAKDOWN_RANK_COLUMN = {
	avg: "avgValue",
	sum: "sumValue",
	min: "minValue",
	max: "maxValue",
	count: "count",
} as const

export interface MetricsBreakdownOutput {
	readonly name: string
	readonly avgValue: number
	readonly minValue: number
	readonly maxValue: number
	readonly sumValue: number
	readonly count: number
}

export function metricsBreakdownQuery(opts: MetricsBreakdownOpts) {
	const { tbl, isHistogram } = resolveMetricTable(opts.metricType)
	const limit = opts.limit ?? 10
	const groupKey = opts.groupByAttributeKey
	const resourceGroupKey = opts.groupByResourceAttributeKey

	return from(tbl as typeof MetricsSum)
		.select(($) => {
			const exprs = metricsSelectExprs($, isHistogram)
			return {
				// Break down by a resource attribute or metric label value when
				// requested, otherwise by service.
				name: resourceGroupKey
					? $.ResourceAttributes.get(resourceGroupKey)
					: groupKey
						? $.Attributes.get(groupKey)
						: $.ServiceName,
				avgValue: exprs.avgValue,
				minValue: exprs.minValue,
				maxValue: exprs.maxValue,
				sumValue: exprs.sumValue,
				count: exprs.dataPointCount,
			}
		})
		.where(($) => [
			$.MetricName.eq(param.string("metricName")),
			$.OrgId.eq(orgIdParam),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			// Drop datapoints missing the label so an empty bucket doesn't dominate.
			CH.when(groupKey, (k: string) => $.Attributes.get(k).neq("")),
			CH.when(resourceGroupKey, (k: string) => $.ResourceAttributes.get(k).neq("")),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			opts.environments !== undefined && opts.environments.length > 0
				? CH.inList(deploymentEnvExpr($.ResourceAttributes), opts.environments)
				: undefined,
			...datapointFilterConditions(opts.attributeFilters),
			...resourceFilterConditions(opts.resourceAttributeFilters),
		])
		.groupBy("name")
		.orderBy([BREAKDOWN_RANK_COLUMN[opts.rankBy ?? "count"], "desc"])
		.limit(limit)
		.format("JSON")
}

// List metrics — reads the hourly `metric_catalog` rollup

export interface ListMetricsOpts {
	serviceName?: string
	metricType?: string
	search?: string
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
	return from(MetricCatalog)
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
		])
		.groupBy("metricName", "metricType", "serviceName")
		.orderBy(["lastSeen", "desc"], ["metricName", "asc"], ["metricType", "asc"], ["serviceName", "asc"])
		.limit(opts.limit ?? 100)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

// Metrics summary — reads the hourly `metric_catalog` rollup

export interface MetricsSummaryOutput {
	readonly metricType: string
	readonly metricCount: number
	readonly dataPointCount: number
}

export interface MetricsSummaryOpts {
	serviceName?: string
}

export function metricsSummaryQuery(opts?: MetricsSummaryOpts) {
	return from(MetricCatalog)
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
