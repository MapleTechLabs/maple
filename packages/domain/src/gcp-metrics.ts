/**
 * What Maple collects from a connected Google Cloud project, folder or organization. The metric
 * table is the whole metrics scope: the poller issues one `timeSeries.list` query per entry, and
 * anything that charts Google Cloud metrics reads the Maple names from here.
 *
 * Cloud Monitoring aligns every series to 60 seconds and reduces it to the project, the group's
 * `resourceLabels` and the metric's `labels`; every other label (revision, pod, response code,
 * device) is aggregated away before it reaches Maple, which is what bounds cardinality.
 */

export interface GcpMetric {
	/** Cloud Monitoring metric type. */
	readonly type: string
	/** Metric name in Maple: the type under a `gcp.` prefix, e.g. `gcp.run.request_count`. */
	readonly name: string
	readonly unit: string
	readonly description: string
	/**
	 * What Maple stores: `sum` is a delta counter per minute, `gauge` a sampled value, and
	 * `quantiles` are p50/p95/p99 gauges (attribute `quantile`) computed from a distribution.
	 */
	readonly kind: "sum" | "gauge" | "quantiles"
	readonly aligner: "ALIGN_DELTA" | "ALIGN_MEAN"
	readonly reducer: "REDUCE_SUM" | "REDUCE_MEAN"
	/** Metric labels kept as attributes under their Cloud Monitoring names. */
	readonly labels: ReadonlyArray<string>
	/** Multiplier from the Cloud Monitoring unit to `unit`. */
	readonly scale: number
}

export interface GcpMetricGroup {
	/** Monitored resource type the series are read from. */
	readonly resourceType: string
	/** Resource labels each series keeps; they become the resource attributes. */
	readonly resourceLabels: ReadonlyArray<string>
	readonly metrics: ReadonlyArray<GcpMetric>
}

/** `run.googleapis.com/request_count` -> `gcp.run.request_count`. */
const mapleName = (type: string): string => {
	const [domain = "", ...path] = type.split("/")
	return ["gcp", domain.split(".")[0], ...path].join(".")
}

const counter = (
	type: string,
	unit: string,
	description: string,
	labels: ReadonlyArray<string> = [],
): GcpMetric => ({
	type,
	name: mapleName(type),
	unit,
	description,
	kind: "sum",
	aligner: "ALIGN_DELTA",
	reducer: "REDUCE_SUM",
	labels,
	scale: 1,
})

const gauge = (
	type: string,
	unit: string,
	description: string,
	reducer: GcpMetric["reducer"],
	labels: ReadonlyArray<string> = [],
): GcpMetric => ({
	type,
	name: mapleName(type),
	unit,
	description,
	kind: "gauge",
	aligner: "ALIGN_MEAN",
	reducer,
	labels,
	scale: 1,
})

/** A distribution, summed across the group so the percentiles cover every instance in it. */
const quantiles = (type: string, unit: string, description: string, scale = 1): GcpMetric => ({
	type,
	name: mapleName(type),
	unit,
	description,
	kind: "quantiles",
	aligner: "ALIGN_DELTA",
	reducer: "REDUCE_SUM",
	labels: [],
	scale,
})

/**
 * Cloud Asset Inventory types kept in the resource inventory: the projects in a connector's
 * scope, and the resources the metrics below describe.
 */
export const GCP_PROJECT_ASSET_TYPE = "cloudresourcemanager.googleapis.com/Project"
export const GCP_ASSET_TYPES: ReadonlyArray<string> = [
	GCP_PROJECT_ASSET_TYPE,
	"run.googleapis.com/Service",
	"run.googleapis.com/Job",
	// 1st and 2nd gen.
	"cloudfunctions.googleapis.com/CloudFunction",
	"cloudfunctions.googleapis.com/Function",
	"container.googleapis.com/Cluster",
	"compute.googleapis.com/Instance",
	"sqladmin.googleapis.com/Instance",
	"pubsub.googleapis.com/Topic",
	"pubsub.googleapis.com/Subscription",
	// Load balancing: both cover global and regional resources.
	"compute.googleapis.com/UrlMap",
	"compute.googleapis.com/BackendService",
	"compute.googleapis.com/ForwardingRule",
]

export const GCP_METRIC_GROUPS: ReadonlyArray<GcpMetricGroup> = [
	{
		// Cloud Run services, and Cloud Functions (2nd gen), which run on Cloud Run.
		resourceType: "cloud_run_revision",
		resourceLabels: ["service_name", "location"],
		metrics: [
			counter("run.googleapis.com/request_count", "{request}", "Requests that reached the service", [
				"response_code_class",
			]),
			quantiles("run.googleapis.com/request_latencies", "ms", "Request latency"),
			gauge(
				"run.googleapis.com/container/instance_count",
				"{instance}",
				"Container instances",
				"REDUCE_SUM",
				["state"],
			),
			quantiles(
				"run.googleapis.com/container/cpu/utilizations",
				"1",
				"CPU utilization across container instances",
			),
			quantiles(
				"run.googleapis.com/container/memory/utilizations",
				"1",
				"Memory utilization across container instances",
			),
			quantiles(
				"run.googleapis.com/container/max_request_concurrencies",
				"{request}",
				"Peak concurrent requests per container instance",
			),
			counter(
				"run.googleapis.com/container/billable_instance_time",
				"s",
				"Billable container instance time",
			),
		],
	},
	{
		// Cloud Functions (1st gen).
		resourceType: "cloud_function",
		resourceLabels: ["function_name", "region"],
		metrics: [
			counter(
				"cloudfunctions.googleapis.com/function/execution_count",
				"{execution}",
				"Function executions",
				["status"],
			),
			// Reported in nanoseconds.
			quantiles(
				"cloudfunctions.googleapis.com/function/execution_times",
				"ms",
				"Function execution time",
				1e-6,
			),
			gauge(
				"cloudfunctions.googleapis.com/function/instance_count",
				"{instance}",
				"Function instances",
				"REDUCE_SUM",
				["state"],
			),
			quantiles(
				"cloudfunctions.googleapis.com/function/user_memory_bytes",
				"By",
				"Peak memory used per execution",
			),
			counter(
				"cloudfunctions.googleapis.com/function/network_egress",
				"By",
				"Outgoing network traffic",
			),
		],
	},
	{
		// GKE workloads, one series per container name: pods are aggregated away.
		resourceType: "k8s_container",
		resourceLabels: ["cluster_name", "location", "namespace_name", "container_name"],
		metrics: [
			counter("kubernetes.io/container/cpu/core_usage_time", "s", "CPU time used"),
			gauge(
				"kubernetes.io/container/cpu/limit_utilization",
				"1",
				"Fraction of the CPU limit in use, averaged over pods",
				"REDUCE_MEAN",
			),
			gauge("kubernetes.io/container/memory/used_bytes", "By", "Memory in use", "REDUCE_SUM", [
				"memory_type",
			]),
			gauge(
				"kubernetes.io/container/memory/limit_utilization",
				"1",
				"Fraction of the memory limit in use, averaged over pods",
				"REDUCE_MEAN",
				["memory_type"],
			),
			counter("kubernetes.io/container/restart_count", "{restart}", "Container restarts"),
		],
	},
	{
		// GKE nodes, averaged per cluster: node names churn with autoscaling.
		resourceType: "k8s_node",
		resourceLabels: ["cluster_name", "location"],
		metrics: [
			gauge(
				"kubernetes.io/node/cpu/allocatable_utilization",
				"1",
				"Fraction of allocatable CPU in use, averaged over nodes",
				"REDUCE_MEAN",
			),
			gauge(
				"kubernetes.io/node/memory/allocatable_utilization",
				"1",
				"Fraction of allocatable memory in use, averaged over nodes",
				"REDUCE_MEAN",
				["memory_type"],
			),
		],
	},
	{
		// Compute Engine VMs. `instance_name` is a metric label; it names the service.
		resourceType: "gce_instance",
		resourceLabels: ["instance_id", "zone"],
		metrics: [
			gauge(
				"compute.googleapis.com/instance/cpu/utilization",
				"1",
				"Fraction of the allocated CPU in use",
				"REDUCE_MEAN",
				["instance_name"],
			),
			// E2 machine types only.
			gauge(
				"compute.googleapis.com/instance/memory/balloon/ram_used",
				"By",
				"Memory in use",
				"REDUCE_SUM",
				["instance_name"],
			),
			counter("compute.googleapis.com/instance/network/received_bytes_count", "By", "Bytes received", [
				"instance_name",
			]),
			counter("compute.googleapis.com/instance/network/sent_bytes_count", "By", "Bytes sent", [
				"instance_name",
			]),
			counter("compute.googleapis.com/instance/disk/read_bytes_count", "By", "Bytes read from disk", [
				"instance_name",
			]),
			counter("compute.googleapis.com/instance/disk/write_bytes_count", "By", "Bytes written to disk", [
				"instance_name",
			]),
		],
	},
	{
		resourceType: "cloudsql_database",
		resourceLabels: ["database_id", "region"],
		metrics: [
			gauge(
				"cloudsql.googleapis.com/database/cpu/utilization",
				"1",
				"Fraction of the reserved CPU in use",
				"REDUCE_MEAN",
			),
			gauge(
				"cloudsql.googleapis.com/database/memory/utilization",
				"1",
				"Fraction of the memory quota in use",
				"REDUCE_MEAN",
			),
			gauge(
				"cloudsql.googleapis.com/database/disk/utilization",
				"1",
				"Fraction of the disk quota in use",
				"REDUCE_MEAN",
			),
			// MySQL and SQL Server.
			gauge(
				"cloudsql.googleapis.com/database/network/connections",
				"{connection}",
				"Connections to the instance",
				"REDUCE_SUM",
			),
			// PostgreSQL, summed over databases.
			gauge(
				"cloudsql.googleapis.com/database/postgresql/num_backends",
				"{connection}",
				"Connections to the instance",
				"REDUCE_SUM",
			),
			counter(
				"cloudsql.googleapis.com/database/disk/read_ops_count",
				"{operation}",
				"Disk read operations",
			),
			counter(
				"cloudsql.googleapis.com/database/disk/write_ops_count",
				"{operation}",
				"Disk write operations",
			),
			gauge(
				"cloudsql.googleapis.com/database/replication/replica_lag",
				"s",
				"How far a read replica is behind its primary",
				"REDUCE_MEAN",
			),
		],
	},
	{
		resourceType: "pubsub_subscription",
		resourceLabels: ["subscription_id"],
		metrics: [
			gauge(
				"pubsub.googleapis.com/subscription/num_undelivered_messages",
				"{message}",
				"Unacknowledged messages",
				"REDUCE_SUM",
			),
			gauge(
				"pubsub.googleapis.com/subscription/oldest_unacked_message_age",
				"s",
				"Age of the oldest unacknowledged message",
				"REDUCE_MEAN",
			),
			counter(
				"pubsub.googleapis.com/subscription/sent_message_count",
				"{message}",
				"Messages sent to subscribers",
			),
			counter(
				"pubsub.googleapis.com/subscription/ack_message_count",
				"{message}",
				"Messages acknowledged",
			),
			counter(
				"pubsub.googleapis.com/subscription/push_request_count",
				"{request}",
				"Push delivery attempts",
				["response_class"],
			),
			counter(
				"pubsub.googleapis.com/subscription/dead_letter_message_count",
				"{message}",
				"Messages moved to the dead-letter topic",
			),
		],
	},
	{
		resourceType: "pubsub_topic",
		resourceLabels: ["topic_id"],
		metrics: [
			counter("pubsub.googleapis.com/topic/send_request_count", "{request}", "Publish requests", [
				"response_class",
			]),
		],
	},
	{
		// Global external Application Load Balancers.
		resourceType: "https_lb_rule",
		resourceLabels: ["url_map_name", "backend_target_name"],
		metrics: [
			counter("loadbalancing.googleapis.com/https/request_count", "{request}", "Requests served", [
				"response_code_class",
			]),
			quantiles(
				"loadbalancing.googleapis.com/https/total_latencies",
				"ms",
				"Latency from the request reaching the proxy to the last response byte",
			),
			quantiles(
				"loadbalancing.googleapis.com/https/backend_latencies",
				"ms",
				"Latency from the proxy sending the request to the backend to the last response byte",
			),
			counter(
				"loadbalancing.googleapis.com/https/backend_request_count",
				"{request}",
				"Requests sent to backends",
				["response_code_class"],
			),
			counter(
				"loadbalancing.googleapis.com/https/request_bytes_count",
				"By",
				"Request bytes received from clients",
			),
			counter(
				"loadbalancing.googleapis.com/https/response_bytes_count",
				"By",
				"Response bytes sent to clients",
			),
		],
	},
]
