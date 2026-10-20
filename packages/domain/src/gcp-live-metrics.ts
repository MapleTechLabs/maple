import { Schema } from "effect"
import type { MetricType } from "./query-engine"

/**
 * A Cloud Monitoring metric type: one of Google's metric domains, a slash, then a path, e.g.
 * `compute.googleapis.com/instance/cpu/utilization` or `kubernetes.io/container/cpu/core_usage_time`.
 * The query engine reads these live from Google instead of from the warehouse.
 */
const GCP_METRIC_TYPE =
	/^(?:[a-z0-9-]+\.)*(?:googleapis\.com|kubernetes\.io|istio\.io|knative\.dev)\/[A-Za-z0-9_.\-/]+$/

export const isGcpMetricType = (metricName: string): boolean => GCP_METRIC_TYPE.test(metricName)

/** A metric with data in the last ~25 hours (Cloud Monitoring `metricDescriptors?activeOnly=true`). */
export const GcpMetricDescriptor = Schema.Struct({
	type: Schema.String,
	metricKind: Schema.Literals(["GAUGE", "DELTA", "CUMULATIVE"]),
	valueType: Schema.Literals(["BOOL", "INT64", "DOUBLE", "STRING", "DISTRIBUTION", "MONEY"]),
	unit: Schema.String,
	description: Schema.String,
	/** Resource types with recent data. Empty when Google does not list them (e.g. logging metrics). */
	monitoredResourceTypes: Schema.Array(Schema.String),
	/** Metric label keys. Resource labels (project_id, region, ...) are not listed here. */
	labels: Schema.Array(Schema.String),
})
export type GcpMetricDescriptor = typeof GcpMetricDescriptor.Type

/** A monitored resource type (Cloud Monitoring `monitoredResourceDescriptors`) and its label keys. */
export const GcpMonitoredResourceType = Schema.Struct({
	type: Schema.String,
	labels: Schema.Array(Schema.String),
})
export type GcpMonitoredResourceType = typeof GcpMonitoredResourceType.Type

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
