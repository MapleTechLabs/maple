// ---------------------------------------------------------------------------
// Typed Metrics Queries
//
// DSL-based query definitions for metrics timeseries, breakdown, and
// a raw-SQL builder for counter rate/increase (which requires CTEs).
// ---------------------------------------------------------------------------

import type { MetricType } from "../../query-engine"
import * as CH from "../expr"
import * as T from "../types"
import { param } from "../param"
import { from, type CHQuery } from "../query"
import { table } from "../table"
import { MetricsSum, MetricCatalog, SpanMetricsCallsHourly } from "../tables"
import { compileCH } from "../compile"
import { resolveMetricTable, metricsSelectExprs } from "./query-helpers"

// ---------------------------------------------------------------------------
// Shared options & output types
// ---------------------------------------------------------------------------

interface MetricsQueryOpts {
	metricType: MetricType
	serviceName?: string
	groupByAttributeKey?: string
	attributeKey?: string
	attributeValue?: string
}

export interface MetricsTimeseriesOpts extends MetricsQueryOpts {}

export interface MetricsTimeseriesOutput {
	readonly bucket: string
	readonly serviceName: string
	readonly attributeValue: string
	readonly avgValue: number
	readonly minValue: number
	readonly maxValue: number
	readonly sumValue: number
	readonly dataPointCount: number
}

// ---------------------------------------------------------------------------
// Timeseries query — handles all 4 metric types
// ---------------------------------------------------------------------------

export function metricsTimeseriesQuery(opts: MetricsTimeseriesOpts) {
	const { tbl, isHistogram } = resolveMetricTable(opts.metricType)

	const q = from(tbl as typeof MetricsSum)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
			serviceName: $.ServiceName,
			attributeValue: opts.groupByAttributeKey
				? $.Attributes.get(opts.groupByAttributeKey)
				: CH.lit(""),
			...metricsSelectExprs($, isHistogram),
		}))
		.where(($) => [
			$.MetricName.eq(param.string("metricName")),
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.attributeKey, (k: string) => $.Attributes.get(k).eq(opts.attributeValue ?? "")),
		])

	return (
		opts.groupByAttributeKey
			? q.groupBy("bucket", "serviceName", "attributeValue")
			: q.groupBy("bucket", "serviceName")
	)
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Rate/increase timeseries — raw SQL (requires CTE)
// ---------------------------------------------------------------------------

export interface MetricsRateTimeseriesOpts {
	metricName?: string
	bucketSeconds?: number
	serviceName?: string
	groupByAttributeKey?: string
	attributeKey?: string
	attributeValue?: string
}

export interface MetricsRateTimeseriesOutput {
	readonly bucket: string
	readonly serviceName: string
	readonly attributeValue: string
	readonly rateValue: number
	readonly increaseValue: number
	readonly dataPointCount: number
}

const SPAN_METRICS_CALLS_NAMES = new Set(["span.metrics.calls", "calls"])

function canUseSpanMetricsCallsHourly(opts: MetricsRateTimeseriesOpts): boolean {
	return (
		opts.metricName !== undefined &&
		SPAN_METRICS_CALLS_NAMES.has(opts.metricName) &&
		opts.bucketSeconds !== undefined &&
		opts.bucketSeconds >= 3600 &&
		opts.bucketSeconds % 3600 === 0 &&
		(opts.attributeValue === undefined || opts.attributeKey !== undefined) &&
		(opts.attributeKey === undefined || opts.attributeKey === "span.kind") &&
		(opts.groupByAttributeKey === undefined || opts.groupByAttributeKey === "span.kind")
	)
}

function metricsTimeseriesRateFromSpanMetricsCallsHourly(
	opts: MetricsRateTimeseriesOpts,
): CHQuery<any, MetricsRateTimeseriesOutput, {}> {
	const bucket = CH.toStartOfInterval(CH.toDateTime(param.dateTime("startTime")), param.int("bucketSeconds"))
	const previousBucket = CH.intervalSub(bucket, param.int("bucketSeconds"))
	const endBucket = CH.toStartOfInterval(CH.toDateTime(param.dateTime("endTime")), param.int("bucketSeconds"))

	const hourlySql = compileCH(
		from(SpanMetricsCallsHourly)
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
				$.OrgId.eq(param.string("orgId")),
				$.MetricName.eq(param.string("metricName")),
				$.Hour.gte(previousBucket),
				$.Hour.lte(endBucket),
				CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
				CH.when(opts.attributeKey === "span.kind" ? opts.attributeValue : undefined, (v: string) =>
					$.SpanKind.eq(v),
				),
			])
			.groupBy(
				"Hour",
				"ServiceName",
				"MetricName",
				"SpanKind",
				"AttrFingerprint",
				"ResourceFingerprint",
				"StartTimeUnix",
			),
		{},
		{ skipFormat: true },
	).sql

	const hourlyValues = table("hourly_values", {
		Hour: T.dateTime,
		ServiceName: T.string,
		MetricName: T.string,
		SpanKind: T.string,
		AttrFingerprint: T.uint64,
		ResourceFingerprint: T.uint64,
		StartTimeUnix: T.dateTime64,
		Value: T.float64,
	})

	const deltasSql = compileCH(
		from(hourlyValues)
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
					delta: $.Value.sub(CH.over(CH.lagInFrame($.Value, 1, $.Value), onePrecedingFrame)),
				}
			})
			.where(($) => [$.Hour.gte(bucket)]),
		{},
		{ skipFormat: true },
	).sql

	const deltas = table("with_deltas", {
		Hour: T.dateTime,
		ServiceName: T.string,
		SpanKind: T.string,
		delta: T.float64,
	})

	const q = from(deltas)
		.withCTE("hourly_values", hourlySql)
		.withCTE("with_deltas", deltasSql)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Hour, param.int("bucketSeconds")),
			serviceName: $.ServiceName,
			attributeValue: opts.groupByAttributeKey === "span.kind" ? $.SpanKind : CH.lit(""),
			rateValue: CH.sumIf($.delta.div(param.int("bucketSeconds")), $.delta.gte(0)),
			increaseValue: CH.sumIf($.delta, $.delta.gte(0)),
			dataPointCount: CH.count(),
		}))
		.where(($) => [$.Hour.gte(bucket), $.Hour.lte(endBucket)])

	return (opts.groupByAttributeKey === "span.kind"
		? q.groupBy("bucket", "serviceName", "attributeValue")
		: q.groupBy("bucket", "serviceName")
	)
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

export function metricsTimeseriesRateQuery(
	opts: MetricsRateTimeseriesOpts,
): CHQuery<any, MetricsRateTimeseriesOutput, {}> {
	if (canUseSpanMetricsCallsHourly(opts)) return metricsTimeseriesRateFromSpanMetricsCallsHourly(opts)

	// CTE: compute deltas using window functions.
	//
	// The PARTITION BY must isolate each emitting process: a cumulative counter
	// is monotonic only *within one series of one pod*. `ResourceAttributes`
	// (carries k8s.pod.name / service.instance.id) separates replicas, and
	// `StartTimeUnix` separates accumulation epochs (counter resets) within a
	// pod. Omitting them merges every replica's series into one partition, so
	// `lagInFrame` computes deltas across interleaved pods — each step from a
	// low-counter pod to a high-counter one books that pod's entire accumulated
	// value as a bogus increase, inflating the result by orders of magnitude on
	// any multi-replica service.
	//
	// The two attribute Maps are folded into fixed-width `cityHash64` series
	// fingerprints rather than partitioning by the raw `Map` columns: the window
	// must sort every row by the partition key, and comparing serialized Maps per
	// row dominates the query cost (raw `metrics_sum` scans of span.metrics.calls
	// ran ~7s p95). Hashing keeps per-series identity — points of one series share
	// one exporter, so map key order is stable — at a ~2^-64 collision risk.
	const cteSql = compileCH(
		from(MetricsSum)
			.select(($) => {
				const onePrecedingFrame = CH.windowSpec({
					partitionBy: [
						$.ServiceName,
						$.MetricName,
						CH.cityHash64(CH.mapKeys($.Attributes), CH.mapValues($.Attributes)),
						CH.cityHash64(CH.mapKeys($.ResourceAttributes), CH.mapValues($.ResourceAttributes)),
						$.StartTimeUnix,
					],
					orderBy: [[$.TimeUnix, "asc"]],
					frame: CH.rowsBetween(CH.preceding(1), CH.currentRow),
				})
				const previousValue = CH.over(CH.lagInFrame($.Value, 1, $.Value), onePrecedingFrame)
				const previousTimeUnix = CH.over(CH.lagInFrame($.TimeUnix, 1, $.TimeUnix), onePrecedingFrame)

				return {
					TimeUnix: $.TimeUnix,
					ServiceName: $.ServiceName,
					Attributes: $.Attributes,
					Value: $.Value,
					delta: $.Value.sub(previousValue),
					time_delta: CH.toFloat64(
						CH.toUnixTimestamp64Nano($.TimeUnix).sub(CH.toUnixTimestamp64Nano(previousTimeUnix)),
					).div(1000000000),
				}
			})
			.where(($) => [
				$.MetricName.eq(param.string("metricName")),
				$.OrgId.eq(param.string("orgId")),
				CH.dynamicColumn<number>("IsMonotonic").eq(1),
				$.TimeUnix.gte(CH.intervalSub(param.dateTime("startTime"), param.int("bucketSeconds"))),
				$.TimeUnix.lte(param.dateTime("endTime")),
				CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
				CH.when(opts.attributeKey, (k: string) => $.Attributes.get(k).eq(opts.attributeValue ?? "")),
			]),
		{},
		{ skipFormat: true },
	)

	// Outer query: aggregate deltas into rate/increase per bucket
	const cteTable = table("with_deltas", {
		TimeUnix: T.dateTime64,
		ServiceName: T.string,
		Attributes: T.map(T.string, T.string),
		Value: T.float64,
		delta: T.float64,
		time_delta: T.float64,
	})

	const q = from(cteTable)
		.withCTE("with_deltas", cteSql.sql)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
			serviceName: $.ServiceName,
			attributeValue: opts.groupByAttributeKey
				? $.Attributes.get(opts.groupByAttributeKey)
				: CH.lit(""),
			rateValue: CH.sumIf($.delta.div($.time_delta), $.delta.gte(0).and($.time_delta.gt(0))),
			increaseValue: CH.sumIf($.delta, $.delta.gte(0)),
			dataPointCount: CH.count(),
		}))
		.where(($) => [$.TimeUnix.gte(param.dateTime("startTime"))])

	return (
		opts.groupByAttributeKey
			? q.groupBy("bucket", "serviceName", "attributeValue")
			: q.groupBy("bucket", "serviceName")
	)
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Breakdown query
// ---------------------------------------------------------------------------

export interface MetricsBreakdownOpts {
	metricType: MetricType
	limit?: number
}

export interface MetricsBreakdownOutput {
	readonly name: string
	readonly avgValue: number
	readonly sumValue: number
	readonly count: number
}

export function metricsBreakdownQuery(opts: MetricsBreakdownOpts) {
	const { tbl, isHistogram } = resolveMetricTable(opts.metricType)
	const limit = opts.limit ?? 10

	return from(tbl as typeof MetricsSum)
		.select(($) => {
			const exprs = metricsSelectExprs($, isHistogram)
			return {
				name: $.ServiceName,
				avgValue: exprs.avgValue,
				sumValue: exprs.sumValue,
				count: exprs.dataPointCount,
			}
		})
		.where(($) => [
			$.MetricName.eq(param.string("metricName")),
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(limit)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// List metrics — reads the hourly `metric_catalog` rollup
// ---------------------------------------------------------------------------

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
	readonly firstSeen: string
	readonly lastSeen: string
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
			$.OrgId.eq(param.string("orgId")),
			// Floor the start bound to the hour so the oldest catalog bucket
			// (Hour is already hour-truncated) isn't dropped for mid-hour ranges.
			$.Hour.gte(CH.toStartOfInterval(CH.toDateTime(param.dateTime("startTime")), 3600)),
			$.Hour.lte(param.dateTime("endTime")),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
			CH.when(opts.metricType, (v: string) => $.MetricType.eq(v)),
			CH.when(opts.search, (v: string) => $.MetricName.ilike(`%${v}%`)),
		])
		.groupBy("metricName", "metricType", "serviceName")
		.orderBy(["lastSeen", "desc"])
		.limit(opts.limit ?? 100)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Metrics summary — reads the hourly `metric_catalog` rollup
// ---------------------------------------------------------------------------

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
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(CH.toStartOfInterval(CH.toDateTime(param.dateTime("startTime")), 3600)),
			$.Hour.lte(param.dateTime("endTime")),
			CH.when(opts?.serviceName, (v: string) => $.ServiceName.eq(v)),
		])
		.groupBy("metricType")
		.format("JSON")
}
