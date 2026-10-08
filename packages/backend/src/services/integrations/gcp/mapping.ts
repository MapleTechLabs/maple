/**
 * Cloud Monitoring time series -> OTel metric rows, and Cloud Asset Inventory search results ->
 * inventory entries.
 *
 * Resource attributes follow the log receiver (`apps/ingest/src/gcp_logging.rs`), so a workload's
 * metrics and logs land on the same service: compute workloads are named after the workload,
 * everything else is `gcp/<resource type>`.
 */
import type { GcpMetric, GcpMetricGroup } from "@maple/domain/gcp-metrics"
import {
	fmtMetricTs,
	type MetricAttrs,
	type MetricGaugeRow,
	type MetricSumRow,
} from "@maple/backend/services/warehouse/metric-rows"
import { msToDate, timestampMs } from "@maple/backend/platform/time"
import { Predicate } from "effect"
import type { GcpBucketOptions, GcpResourceSearchResult, GcpTimeSeries } from "./api"

export const GCP_SCOPE_NAME = "gcp.monitoring"

const ALIGNMENT_MS = 60_000
const QUANTILES = [0.5, 0.95, 0.99]
const DELTA_TEMPORALITY = 1

export interface GcpMetricRows {
	readonly sumRows: Array<MetricSumRow>
	readonly gaugeRows: Array<MetricGaugeRow>
}

/** `labels` are the series' resource labels: the project plus the group's `resourceLabels`. */
export const gcpResourceAttributes = (
	resourceType: string,
	labels: MetricAttrs,
	metricLabels: MetricAttrs,
): MetricAttrs => {
	const attributes: MetricAttrs = { "cloud.provider": "gcp", "gcp.resource.type": resourceType }
	const set = (key: string, value: string | undefined) => {
		if (value) attributes[key] = value
	}
	set("cloud.account.id", labels.project_id)

	// `location` names a zone for zonal resources and a region otherwise.
	const location = labels.zone ?? labels.location ?? labels.region
	const zone = location?.match(/^(.+)-[a-z]$/)
	set("cloud.region", zone ? zone[1] : location)
	if (zone) set("cloud.availability_zone", location)

	let workload: string | undefined
	if (resourceType === "cloud_run_revision") {
		workload = labels.service_name
		set("cloud.platform", "gcp_cloud_run")
		set("faas.name", workload)
	} else if (resourceType === "cloud_function") {
		workload = labels.function_name
		set("cloud.platform", "gcp_cloud_functions")
		set("faas.name", workload)
	} else if (resourceType === "k8s_container") {
		workload = labels.container_name
		set("cloud.platform", "gcp_kubernetes_engine")
		set("k8s.cluster.name", labels.cluster_name)
		set("k8s.namespace.name", labels.namespace_name)
		set("k8s.container.name", workload)
	} else if (resourceType === "k8s_node") {
		set("cloud.platform", "gcp_kubernetes_engine")
		set("k8s.cluster.name", labels.cluster_name)
	} else if (resourceType === "gce_instance") {
		workload = metricLabels.instance_name
		set("cloud.platform", "gcp_compute_engine")
		set("host.id", labels.instance_id)
		set("host.name", workload)
	}
	attributes["service.name"] = workload || `gcp/${resourceType}`

	for (const [label, value] of Object.entries(labels)) attributes[`gcp.resource.labels.${label}`] = value
	return attributes
}

/**
 * Bounds of bucket `index`. Bucket 0 is the underflow bucket and the last one the overflow
 * bucket; both are open-ended, so they collapse to their one finite bound.
 */
const bucketBounds = (options: GcpBucketOptions, index: number): readonly [number, number] => {
	const between = (bound: (edge: number) => number, lastEdge: number): readonly [number, number] => [
		bound(Math.max(index - 1, 0)),
		bound(Math.min(index, lastEdge)),
	]
	if (options.linearBuckets) {
		const { numFiniteBuckets, width, offset = 0 } = options.linearBuckets
		return between((edge) => offset + width * edge, numFiniteBuckets)
	}
	if (options.exponentialBuckets) {
		const { numFiniteBuckets, growthFactor, scale } = options.exponentialBuckets
		return between((edge) => scale * growthFactor ** edge, numFiniteBuckets)
	}
	const bounds = options.explicitBuckets?.bounds ?? []
	return between((edge) => bounds[edge] ?? 0, bounds.length - 1)
}

type GcpDistribution = NonNullable<NonNullable<GcpTimeSeries["points"]>[number]["value"]["distributionValue"]>

/** Quantile `q` by linear interpolation inside its bucket, as Cloud Monitoring's own percentile reducers do. */
export const distributionQuantile = (distribution: GcpDistribution, q: number): number | undefined => {
	const counts = (distribution.bucketCounts ?? []).map(Number)
	const rank = q * counts.reduce((sum, count) => sum + count, 0)
	if (rank === 0 || distribution.bucketOptions === undefined) return undefined
	let seen = 0
	for (const [index, count] of counts.entries()) {
		if (count > 0 && seen + count >= rank) {
			const [lower, upper] = bucketBounds(distribution.bucketOptions, index)
			return lower + (upper - lower) * ((rank - seen) / count)
		}
		seen += count
	}
	return undefined
}

const toDate = (value: string | undefined): Date | null => {
	const ms = value === undefined ? Number.NaN : timestampMs(value)
	return msToDate(Number.isNaN(ms) ? null : ms)
}

/** The `gcp_resources` columns of a search result, or undefined when it names no project. */
export const mapGcpResource = (result: GcpResourceSearchResult) => {
	// A project is found by its `projectId` attribute; everything else carries the id in its name.
	const attribute = result.additionalAttributes?.projectId
	const projectId = Predicate.isString(attribute) ? attribute : /\/projects\/([^/]+)/.exec(result.name)?.[1]
	if (projectId === undefined) return undefined
	return {
		name: result.name,
		assetType: result.assetType,
		projectId,
		location: result.location ?? null,
		displayName: result.displayName ?? null,
		state: result.state ?? null,
		labels: result.labels ?? {},
		resourceCreatedAt: toDate(result.createTime),
		resourceUpdatedAt: toDate(result.updateTime),
	}
}

/**
 * Rows for one metric's series. A point is kept when it ends inside `(startMs, endMs]`: the query
 * interval is closed, so the point ending at `startMs` was already taken by the previous window.
 */
export const mapGcpTimeSeries = (
	query: {
		readonly group: GcpMetricGroup
		readonly metric: GcpMetric
		readonly startMs: number
		readonly endMs: number
	},
	series: ReadonlyArray<GcpTimeSeries>,
): GcpMetricRows => {
	const { group, metric } = query
	const rows: GcpMetricRows = { sumRows: [], gaugeRows: [] }
	for (const item of series) {
		const metricLabels = item.metric.labels ?? {}
		const resourceAttributes = gcpResourceAttributes(
			group.resourceType,
			item.resource.labels ?? {},
			metricLabels,
		)
		const attributes = Object.fromEntries(
			metric.labels.flatMap((label) => {
				const value = metricLabels[label]
				return value === undefined ? [] : [[label, value]]
			}),
		)
		const row = (endMs: number, value: number, metricAttributes: MetricAttrs): MetricGaugeRow => ({
			timestamp: fmtMetricTs(endMs),
			start_timestamp: fmtMetricTs(metric.kind === "sum" ? endMs - ALIGNMENT_MS : endMs),
			metric_name: metric.name,
			metric_description: metric.description,
			metric_unit: metric.unit,
			metric_attributes: metricAttributes,
			service_name: resourceAttributes["service.name"] ?? "",
			resource_schema_url: "",
			resource_attributes: resourceAttributes,
			scope_schema_url: "",
			scope_name: GCP_SCOPE_NAME,
			scope_version: "",
			scope_attributes: {},
			value: value * metric.scale,
			flags: 0,
			exemplars_trace_id: [],
			exemplars_span_id: [],
			exemplars_timestamp: [],
			exemplars_value: [],
			exemplars_filtered_attributes: [],
		})
		for (const point of item.points ?? []) {
			const endMs = timestampMs(point.interval.endTime)
			if (!(endMs > query.startMs && endMs <= query.endMs)) continue
			if (metric.kind === "quantiles") {
				for (const q of QUANTILES) {
					const value = distributionQuantile(point.value.distributionValue ?? {}, q)
					if (value !== undefined) rows.gaugeRows.push(row(endMs, value, { quantile: String(q) }))
				}
				continue
			}
			const value = point.value.doubleValue ?? Number(point.value.int64Value ?? 0)
			if (!Number.isFinite(value)) continue
			if (metric.kind === "gauge") {
				rows.gaugeRows.push(row(endMs, value, attributes))
			} else if (value > 0) {
				// An idle minute is a zero delta: nothing to store.
				rows.sumRows.push({
					...row(endMs, value, attributes),
					aggregation_temporality: DELTA_TEMPORALITY,
					is_monotonic: true,
				})
			}
		}
	}
	return rows
}
