import type { MetricType } from "./query-engine"

/**
 * A Cloud Monitoring metric type: a service domain, a slash, then a path, e.g.
 * `compute.googleapis.com/instance/cpu/utilization` or `kubernetes.io/container/cpu/core_usage_time`.
 * The query engine reads these live from Google instead of from the warehouse.
 */
const GCP_METRIC_TYPE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[A-Za-z0-9_.\-/]+$/

export const isGcpMetricType = (metricName: string): boolean => GCP_METRIC_TYPE.test(metricName)

export type GcpMetricKind = "GAUGE" | "DELTA" | "CUMULATIVE"
export type GcpMetricValueType = "BOOL" | "INT64" | "DOUBLE" | "STRING" | "DISTRIBUTION" | "MONEY"

/** A metric with data in the last ~25 hours (Cloud Monitoring `metricDescriptors?activeOnly=true`). */
export interface GcpMetricDescriptor {
	readonly type: string
	readonly metricKind: GcpMetricKind
	readonly valueType: GcpMetricValueType
	readonly unit: string
	readonly description: string
	/** Resource types with recent data. Empty when Google does not list them (e.g. logging metrics). */
	readonly monitoredResourceTypes: ReadonlyArray<string>
	/** Metric label keys. Resource labels (project_id, region, ...) are not listed here. */
	readonly labels: ReadonlyArray<string>
}

/** How Maple's query builder treats a Cloud Monitoring metric; undefined for value types PromQL cannot chart. */
export const gcpMetricMapleType = (descriptor: GcpMetricDescriptor): MetricType | undefined => {
	if (descriptor.valueType === "STRING" || descriptor.valueType === "MONEY") return undefined
	if (descriptor.valueType === "DISTRIBUTION") return "histogram"
	return descriptor.metricKind === "GAUGE" ? "gauge" : "sum"
}

/** One series of a PromQL answer. Points are `[epochSeconds, value]`, NaN and infinities dropped. */
export interface GcpPromQlSeries {
	readonly labels: Readonly<Record<string, string>>
	readonly points: ReadonlyArray<readonly [number, number]>
}
