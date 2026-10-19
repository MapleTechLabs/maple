// Metrics queries on a Cloud Monitoring metric type, answered live from Google (see
// `../promql/compile`). Each returns rows the engine shapes exactly like its ClickHouse results.

import { DateTime, Effect } from "effect"
import type { GcpPromQlSeries } from "@maple/domain/gcp-live-metrics"
import { QueryEngineValidationError } from "@maple/domain/http"
import { GcpLiveQueryUnavailableError } from "@maple/domain/http/gcp-live-query-errors"
import type { MetricsFilters, MetricsMetric, QuerySpec } from "@maple/domain/query-engine"
import { ENGINE_UNGROUPED_GROUP_KEY } from "../group-key"
import {
	compileGcpLabelSample,
	compileGcpLabelValues,
	compileGcpMetricQuery,
	gcpPointBucket,
	gcpRangeWindow,
	type GcpPromQl,
} from "../promql/compile"
import type { GcpLiveMetrics } from "./live-metrics"
import type { BucketGroupObs, QueryTenant } from "./query-engine"

type MetricsTimeseriesSpec = Extract<QuerySpec, { readonly source: "metrics"; readonly kind: "timeseries" }>
type MetricsBreakdownSpec = Extract<QuerySpec, { readonly source: "metrics"; readonly kind: "breakdown" }>

export interface GcpTimeseriesRow {
	readonly bucket: string
	readonly groupName: string
	readonly value: number
}

const describe = Effect.fnUntraced(function* <T extends QueryTenant>(
	gcp: GcpLiveMetrics<T> | undefined,
	tenant: T,
	metricName: string,
) {
	if (gcp === undefined) {
		return yield* new GcpLiveQueryUnavailableError({
			message: "Google Cloud metrics are not available in this deployment",
		})
	}
	return { port: gcp, descriptor: yield* gcp.describeMetric(tenant, metricName) }
})

const annotate = (promQl: string) =>
	Effect.annotateCurrentSpan({ "maple.query.backend": "gcp", "maple.gcp.promql": promQl })

const projectsOf = (compiled: GcpPromQl) =>
	compiled.projects === undefined ? undefined : { projects: compiled.projects }

const groupLabelOf = (groupBy: ReadonlyArray<string>, filters: MetricsFilters): string | undefined => {
	if (groupBy.includes("none")) return undefined
	if (groupBy.includes("attribute")) return filters.groupByAttributeKey
	if (groupBy.includes("resource_attribute")) return filters.groupByResourceAttributeKey
	return undefined
}

/** A whole-range window: whole seconds, at least one Google sample period. */
const wholeWindowSeconds = (rangeSeconds: number): number => Math.max(60, Math.ceil(rangeSeconds))

const groupValue = (series: GcpPromQlSeries, groupLabel: string | undefined): string | undefined =>
	groupLabel === undefined ? undefined : series.labels[groupLabel]

/** Keep the `limit` groups with the highest peak, ties by name, like `finalizeTimeseries`. */
const capSeries = (rows: ReadonlyArray<GcpTimeseriesRow>, limit: number): ReadonlyArray<GcpTimeseriesRow> => {
	const peaks = new Map<string, number>()
	for (const row of rows)
		peaks.set(row.groupName, Math.max(peaks.get(row.groupName) ?? -Infinity, row.value))
	const kept = new Set(
		[...peaks]
			.sort(([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName))
			.slice(0, limit)
			.map(([name]) => name),
	)
	return rows.filter((row) => kept.has(row.groupName))
}

/** Bucketed series; `stepSeconds` is the bucket width the points sit on. */
export const gcpMetricsTimeseries = Effect.fnUntraced(function* <T extends QueryTenant>(
	gcp: GcpLiveMetrics<T> | undefined,
	tenant: T,
	query: MetricsTimeseriesSpec,
	range: { readonly startMs: number; readonly endMs: number; readonly bucketSeconds: number },
) {
	const window = gcpRangeWindow(range.startMs, range.endMs, range.bucketSeconds)
	const { port, descriptor } = yield* describe(gcp, tenant, query.filters.metricName)
	if (descriptor === undefined || window.startSeconds > window.endSeconds) {
		return { stepSeconds: window.stepSeconds, rows: [] }
	}
	const groupLabel = groupLabelOf(query.groupBy ?? [], query.filters)
	const compiled = yield* compileGcpMetricQuery(
		{ metric: query.metric, filters: query.filters, groupLabel, windowSeconds: window.stepSeconds },
		descriptor,
	)
	yield* annotate(compiled.query)
	const series = yield* port.queryRange(tenant, {
		query: compiled.query,
		...window,
		...projectsOf(compiled),
	})
	const rows = series.flatMap((s) =>
		s.points.map(([seconds, value]) => ({
			bucket: gcpPointBucket(seconds, window.stepSeconds),
			groupName:
				groupLabel === undefined
					? ENGINE_UNGROUPED_GROUP_KEY
					: groupValue(s, groupLabel) || "(empty)",
			value,
		})),
	)
	return {
		stepSeconds: window.stepSeconds,
		rows: groupLabel !== undefined && query.seriesLimit ? capSeries(rows, query.seriesLimit) : rows,
	}
})

/** One value per group over the whole range, ranked descending. */
export const gcpMetricsBreakdown = Effect.fnUntraced(function* <T extends QueryTenant>(
	gcp: GcpLiveMetrics<T> | undefined,
	tenant: T,
	query: MetricsBreakdownSpec,
	range: { readonly endMs: number; readonly rangeSeconds: number },
) {
	if (query.groupBy === "service") {
		return yield* new QueryEngineValidationError({
			message: "Unsupported Google Cloud metrics query",
			details: [
				"Google Cloud metrics have no service.name; break down by a label (groupBy attribute or resource_attribute)",
			],
		})
	}
	const { port, descriptor } = yield* describe(gcp, tenant, query.filters.metricName)
	if (descriptor === undefined) return []
	const groupLabel = groupLabelOf([query.groupBy], query.filters)
	const compiled = yield* compileGcpMetricQuery(
		{
			metric: query.metric,
			filters: query.filters,
			groupLabel,
			windowSeconds: wholeWindowSeconds(range.rangeSeconds),
		},
		descriptor,
	)
	yield* annotate(compiled.query)
	const series = yield* port.queryInstant(tenant, {
		query: compiled.query,
		timeSeconds: Math.floor(range.endMs / 1000),
		...projectsOf(compiled),
	})
	return series
		.flatMap((s) =>
			s.points.map(([, value]) => ({ name: groupValue(s, groupLabel) || "(empty)", value })),
		)
		.sort((a, b) => b.value - a.value)
		.slice(0, query.limit ?? 10)
})

/**
 * Alert observations: the value and its sample count (the `count` aggregation, as the ClickHouse
 * path's `dataPointCount`) per group. `wholeRange` is one instant query over the window at its end.
 */
export const gcpMetricsAlertBuckets = Effect.fnUntraced(function* <T extends QueryTenant>(
	gcp: GcpLiveMetrics<T> | undefined,
	tenant: T,
	query: MetricsTimeseriesSpec,
	range: {
		readonly startMs: number
		readonly endMs: number
		readonly bucketSeconds: number
		readonly wholeRange?: boolean
	},
) {
	const none: ReadonlyArray<BucketGroupObs> = []
	const { port, descriptor } = yield* describe(gcp, tenant, query.filters.metricName)
	const window = range.wholeRange
		? undefined
		: gcpRangeWindow(range.startMs, range.endMs, range.bucketSeconds)
	if (descriptor === undefined || (window && window.startSeconds > window.endSeconds)) return none
	const groupLabel = groupLabelOf(query.groupBy ?? [], query.filters)
	const windowSeconds = window?.stepSeconds ?? wholeWindowSeconds((range.endMs - range.startMs) / 1000)
	const compile = (metric: MetricsMetric) =>
		compileGcpMetricQuery({ metric, filters: query.filters, groupLabel, windowSeconds }, descriptor)
	const value = yield* compile(query.metric)
	const samples = yield* compile("count")
	yield* annotate(value.query)

	const run = (compiled: GcpPromQl) =>
		window
			? port.queryRange(tenant, { query: compiled.query, ...window, ...projectsOf(compiled) })
			: port.queryInstant(tenant, {
					query: compiled.query,
					timeSeconds: Math.floor(range.endMs / 1000),
					...projectsOf(compiled),
				})
	const [values, counts] = yield* Effect.all([run(value), run(samples)], { concurrency: 2 })

	const rangeStart = DateTime.formatIso(DateTime.makeUnsafe(range.startMs))
	const bucketOf = (seconds: number) => (window ? gcpPointBucket(seconds, window.stepSeconds) : rangeStart)
	const groupKeyOf = (s: GcpPromQlSeries) => groupValue(s, groupLabel) || ENGINE_UNGROUPED_GROUP_KEY
	const sampleCounts = new Map<string, number>()
	for (const s of counts) {
		for (const [seconds, count] of s.points)
			sampleCounts.set(`${bucketOf(seconds)} ${groupKeyOf(s)}`, count)
	}
	return values.flatMap((s) =>
		s.points.map(([seconds, observed]): BucketGroupObs => {
			const bucket = bucketOf(seconds)
			const groupKey = groupKeyOf(s)
			const sampleCount = sampleCounts.get(`${bucket} ${groupKey}`) ?? 0
			return { bucket, groupKey, value: sampleCount > 0 ? observed : null, sampleCount }
		}),
	)
})

/** Label keys: the descriptor's metric labels plus those seen on a few recent series. */
export const gcpMetricAttributeKeys = Effect.fnUntraced(function* <T extends QueryTenant>(
	gcp: GcpLiveMetrics<T> | undefined,
	tenant: T,
	request: {
		readonly metricName: string
		readonly scope?: "span" | "resource"
		readonly limit?: number
		readonly endMs: number
	},
) {
	const { port, descriptor } = yield* describe(gcp, tenant, request.metricName)
	if (descriptor === undefined) return []
	const sample = yield* compileGcpLabelSample(descriptor)
	yield* annotate(sample)
	const series = yield* port.queryInstant(tenant, {
		query: sample,
		timeSeconds: Math.floor(request.endMs / 1000),
	})
	// `scope: "resource"` asks for the labels Google adds beyond the metric's own.
	const resourceOnly = request.scope === "resource"
	const counts = new Map<string, number>(resourceOnly ? [] : descriptor.labels.map((label) => [label, 0]))
	for (const s of series) {
		for (const key of Object.keys(s.labels)) {
			if (key === "__name__" || (resourceOnly && descriptor.labels.includes(key))) continue
			counts.set(key, (counts.get(key) ?? 0) + 1)
		}
	}
	return [...counts]
		.map(([key, count]) => ({ key, count }))
		.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
		.slice(0, request.limit ?? 200)
})

/** Values of one label with their series counts over the range. */
export const gcpMetricAttributeValues = Effect.fnUntraced(function* <T extends QueryTenant>(
	gcp: GcpLiveMetrics<T> | undefined,
	tenant: T,
	request: {
		readonly metricName: string
		readonly attributeKey: string
		readonly limit?: number
		readonly endMs: number
		readonly rangeSeconds: number
	},
) {
	const { port, descriptor } = yield* describe(gcp, tenant, request.metricName)
	if (descriptor === undefined) return []
	const promQl = yield* compileGcpLabelValues(
		descriptor,
		request.attributeKey,
		wholeWindowSeconds(request.rangeSeconds),
	)
	yield* annotate(promQl)
	const series = yield* port.queryInstant(tenant, {
		query: promQl,
		timeSeconds: Math.floor(request.endMs / 1000),
	})
	return series
		.flatMap((s) => {
			const value = s.labels[request.attributeKey]
			const point = s.points[0]
			return value && point ? [{ value, count: point[1] }] : []
		})
		.sort((a, b) => b.count - a.count)
		.slice(0, request.limit ?? 50)
})
