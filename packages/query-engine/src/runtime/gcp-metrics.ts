// Metrics queries on a Cloud Monitoring metric type, answered live from Google (see
// `../promql/compile`). Each returns rows the engine shapes exactly like its ClickHouse results.

import { DateTime, Effect } from "effect"
import type { GcpPromQlSeries } from "@maple/domain/gcp-live-metrics"
import {
	GCP_LIVE_METRICS_NOT_AVAILABLE,
	GcpLiveQueryUnavailableError,
} from "@maple/domain/http/gcp-live-query-errors"
import type { MetricsFilters, QuerySpec } from "@maple/domain/query-engine"
import { ENGINE_UNGROUPED_GROUP_KEY } from "../group-key"
import {
	compileGcpLabelSample,
	compileGcpLabelValues,
	compileGcpMetricQuery,
	compileGcpSampleCount,
	gcpFilterProjects,
	gcpPointBucket,
	gcpRangeWindow,
	reject,
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

/** The metric's descriptor, read from the projects the query reads. */
const describe = Effect.fnUntraced(function* <T extends QueryTenant>(
	gcp: GcpLiveMetrics<T> | undefined,
	tenant: T,
	metricName: string,
	scope: {
		readonly filters?: MetricsFilters
		readonly requireComplete?: boolean
		readonly discovery?: boolean
	} = {},
) {
	if (gcp === undefined) {
		return yield* new GcpLiveQueryUnavailableError({ message: GCP_LIVE_METRICS_NOT_AVAILABLE })
	}
	const read = {
		projects: scope.filters === undefined ? undefined : gcpFilterProjects(scope.filters),
		requireComplete: scope.requireComplete,
		discovery: scope.discovery,
	}
	const metrics = yield* gcp.listMetrics(tenant, read)
	return { port: gcp, read, descriptor: metrics.find((metric) => metric.type === metricName) }
})

const annotate = (promQl: string) =>
	Effect.annotateCurrentSpan({ "maple.query.backend": "gcp", "maple.gcp.promql": promQl })

const groupLabelOf = (groupBy: ReadonlyArray<string>, filters: MetricsFilters): string | undefined => {
	if (groupBy.includes("none")) return undefined
	if (groupBy.includes("attribute")) return filters.groupByAttributeKey
	if (groupBy.includes("resource_attribute")) return filters.groupByResourceAttributeKey
	return undefined
}

/**
 * Google can take up to ~4 minutes to make a sample visible. An alert evaluating a short window
 * at its end would read it empty, so its read ends this much earlier.
 */
const GCP_INGESTION_DELAY_SECONDS = 240

/** A whole-range window: whole seconds, at least one Google sample period. */
const wholeWindowSeconds = (rangeSeconds: number): number => Math.max(60, Math.ceil(rangeSeconds))

/** A series' group: ungrouped, or its label's value, `empty` when the series lacks it. */
const groupOf = (groupLabel: string | undefined, empty: string) => (labels: GcpPromQlSeries["labels"]) =>
	groupLabel === undefined ? ENGINE_UNGROUPED_GROUP_KEY : labels[groupLabel] || empty

interface MergedPoint {
	readonly seconds: number
	readonly group: string
	readonly value: number
}

/**
 * One value per point time and group across projects. Overlapping metrics scopes answer a
 * project twice, so a label set seen before is skipped; the rest combine with `merge`.
 */
const mergeGcpSeries = (
	series: ReadonlyArray<GcpPromQlSeries>,
	merge: GcpPromQl["merge"],
	groupOfLabels: (labels: GcpPromQlSeries["labels"]) => string,
): ReadonlyArray<MergedPoint> => {
	const seen = new Set<string>()
	const cells = new Map<string, { seconds: number; group: string; value?: number; count: number }>()
	for (const one of series) {
		const key = JSON.stringify(Object.entries(one.labels).sort(([a], [b]) => a.localeCompare(b)))
		if (seen.has(key)) continue
		seen.add(key)
		const name = groupOfLabels(one.labels)
		const isCount = merge === "avg" && one.labels.maple_part === "count"
		for (const [seconds, value] of one.points) {
			const cellKey = `${seconds} ${name}`
			const cell = cells.get(cellKey) ?? { seconds, group: name, count: 0 }
			cells.set(cellKey, cell)
			if (isCount) cell.count += value
			else if (cell.value === undefined) cell.value = value
			else
				cell.value =
					merge === "min"
						? Math.min(cell.value, value)
						: merge === "max"
							? Math.max(cell.value, value)
							: cell.value + value
		}
	}
	return [...cells.values()].flatMap(({ seconds, group, value, count }) => {
		if (value === undefined) return []
		if (merge !== "avg") return [{ seconds, group, value }]
		return count > 0 ? [{ seconds, group, value: value / count }] : []
	})
}

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
	const { port, read, descriptor } = yield* describe(gcp, tenant, query.filters.metricName, {
		filters: query.filters,
	})
	if (descriptor === undefined || window.startSeconds > window.endSeconds) {
		return { stepSeconds: window.stepSeconds, rows: [] }
	}
	const groupLabel = groupLabelOf(query.groupBy ?? [], query.filters)
	const compiled = yield* compileGcpMetricQuery(
		{ metric: query.metric, filters: query.filters, groupLabel, windowSeconds: window.stepSeconds },
		descriptor,
	)
	yield* annotate(compiled.query)
	const series = yield* port.queryRange(tenant, { ...read, query: compiled.query, ...window })
	const rows = mergeGcpSeries(series, compiled.merge, groupOf(groupLabel, "(empty)")).map(
		(point): GcpTimeseriesRow => ({
			bucket: gcpPointBucket(point.seconds, window.stepSeconds),
			groupName: point.group,
			value: point.value,
		}),
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
		return yield* reject(
			"Google Cloud metrics have no service.name; break down by a label (groupBy attribute or resource_attribute)",
		)
	}
	const { port, read, descriptor } = yield* describe(gcp, tenant, query.filters.metricName, {
		filters: query.filters,
	})
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
		...read,
		query: compiled.query,
		timeSeconds: Math.floor(range.endMs / 1000),
	})
	return mergeGcpSeries(series, compiled.merge, groupOf(groupLabel, "(empty)"))
		.map((point) => ({ name: point.group, value: point.value }))
		.sort((a, b) => b.value - a.value)
		.slice(0, query.limit ?? 10)
})

/**
 * Alert observations: the value and its sample count per group, as the ClickHouse path's
 * `dataPointCount`. `wholeRange` is one instant query over the window at its end. Every project
 * must answer: an alert must not resolve on the ones that did not.
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
	const { port, read, descriptor } = yield* describe(gcp, tenant, query.filters.metricName, {
		filters: query.filters,
		requireComplete: true,
	})
	const window = range.wholeRange
		? undefined
		: gcpRangeWindow(range.startMs, range.endMs, range.bucketSeconds)
	if (descriptor === undefined || (window && window.startSeconds > window.endSeconds)) return []
	const groupLabel = groupLabelOf(query.groupBy ?? [], query.filters)
	const request = {
		metric: query.metric,
		filters: query.filters,
		groupLabel,
		windowSeconds: window?.stepSeconds ?? wholeWindowSeconds((range.endMs - range.startMs) / 1000),
	}
	const value = yield* compileGcpMetricQuery(request, descriptor)
	const samples = yield* compileGcpSampleCount(request, descriptor)
	yield* annotate(value.query)

	const endSeconds = Math.floor(range.endMs / 1000) - GCP_INGESTION_DELAY_SECONDS
	const run = (compiled: GcpPromQl) =>
		window
			? port.queryRange(tenant, { ...read, query: compiled.query, ...window })
			: port.queryInstant(tenant, { ...read, query: compiled.query, timeSeconds: endSeconds })
	const [values, counts] = yield* Effect.all([run(value), run(samples)], { concurrency: 2 })

	// An empty label groups as "all", like the ClickHouse alert path.
	const group = groupOf(groupLabel, ENGINE_UNGROUPED_GROUP_KEY)
	const rangeStart = DateTime.formatIso(DateTime.makeUnsafe(range.startMs))
	const bucketOf = (seconds: number) => (window ? gcpPointBucket(seconds, window.stepSeconds) : rangeStart)
	const sampleCounts = new Map(
		mergeGcpSeries(counts, samples.merge, group).map((point) => [
			`${point.seconds} ${point.group}`,
			point.value,
		]),
	)
	return mergeGcpSeries(values, value.merge, group).map((point): BucketGroupObs => {
		const sampleCount = sampleCounts.get(`${point.seconds} ${point.group}`) ?? 0
		return {
			bucket: bucketOf(point.seconds),
			groupKey: point.group,
			value: sampleCount > 0 ? point.value : null,
			sampleCount,
		}
	})
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
	const { port, read, descriptor } = yield* describe(gcp, tenant, request.metricName, { discovery: true })
	if (descriptor === undefined) return []
	// `scope: "resource"` asks for the labels Google adds beyond the metric's own.
	const resourceOnly = request.scope === "resource"
	// No resource type to select by: list what every Google series carries, without reading.
	if (descriptor.monitoredResourceTypes.length === 0) {
		return [...(resourceOnly ? [] : descriptor.labels), "monitored_resource", "project_id"]
			.sort()
			.map((key) => ({ key, count: 0 }))
			.slice(0, request.limit ?? 200)
	}
	const sample = yield* compileGcpLabelSample(descriptor)
	yield* annotate(sample)
	const series = yield* port.queryInstant(tenant, {
		...read,
		query: sample,
		timeSeconds: Math.floor(request.endMs / 1000),
	})
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

/** Values of one label with their series counts over the range, summed across projects. */
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
	const { port, read, descriptor } = yield* describe(gcp, tenant, request.metricName, { discovery: true })
	// Without a resource type to select by, values are read only through a filtered chart.
	if (descriptor === undefined || descriptor.monitoredResourceTypes.length === 0) return []
	const promQl = yield* compileGcpLabelValues(
		descriptor,
		request.attributeKey,
		wholeWindowSeconds(request.rangeSeconds),
	)
	yield* annotate(promQl)
	const series = yield* port.queryInstant(tenant, {
		...read,
		query: promQl,
		timeSeconds: Math.floor(request.endMs / 1000),
	})
	return mergeGcpSeries(series, "sum", (labels) => labels[request.attributeKey] ?? "")
		.flatMap((point) => (point.group === "" ? [] : [{ value: point.group, count: point.value }]))
		.sort((a, b) => b.count - a.count)
		.slice(0, request.limit ?? 50)
})
