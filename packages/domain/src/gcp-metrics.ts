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
	/**
	 * What Maple stores: `sum` is a delta counter per minute, `gauge` a sampled value, and
	 * `quantiles` are p50/p95/p99 gauges (attribute `quantile`) of a distribution summed over the
	 * group. A gauge is aligned by mean, the other two as deltas.
	 */
	readonly kind: "sum" | "gauge" | "quantiles"
	readonly unit: string
	readonly description: string
	/** How the series a group folds together are combined. */
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

export const gcpMetricAligner = (metric: GcpMetric) =>
	metric.kind === "gauge" ? "ALIGN_MEAN" : "ALIGN_DELTA"

const metric = (
	kind: GcpMetric["kind"],
	type: string,
	unit: string,
	description: string,
	options: Partial<Pick<GcpMetric, "reducer" | "labels" | "scale">> = {},
): GcpMetric => {
	// `run.googleapis.com/request_count` -> `gcp.run.request_count`.
	const [domain = "", ...path] = type.split("/")
	return {
		type,
		name: ["gcp", domain.split(".")[0], ...path].join("."),
		kind,
		unit,
		description,
		reducer: "REDUCE_SUM",
		labels: [],
		scale: 1,
		...options,
	}
}

const MEAN = { reducer: "REDUCE_MEAN" } as const

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

const RUN = "run.googleapis.com"
const FUNCTIONS = "cloudfunctions.googleapis.com/function"
const GKE = "kubernetes.io"
const GCE = "compute.googleapis.com/instance"
const SQL = "cloudsql.googleapis.com/database"
const PUBSUB = "pubsub.googleapis.com"
const LB = "loadbalancing.googleapis.com/https"

const INSTANCE = { labels: ["instance_name"] } as const

export const GCP_METRIC_GROUPS: ReadonlyArray<GcpMetricGroup> = [
	{
		// Cloud Run services, and Cloud Functions (2nd gen), which run on Cloud Run.
		resourceType: "cloud_run_revision",
		resourceLabels: ["service_name", "location"],
		metrics: [
			metric("sum", `${RUN}/request_count`, "{request}", "Requests that reached the service", {
				labels: ["response_code_class"],
			}),
			metric("quantiles", `${RUN}/request_latencies`, "ms", "Request latency"),
			metric("gauge", `${RUN}/container/instance_count`, "{instance}", "Container instances", {
				labels: ["state"],
			}),
			metric(
				"quantiles",
				`${RUN}/container/cpu/utilizations`,
				"1",
				"CPU utilization across container instances",
			),
			metric(
				"quantiles",
				`${RUN}/container/memory/utilizations`,
				"1",
				"Memory utilization across container instances",
			),
			metric(
				"quantiles",
				`${RUN}/container/max_request_concurrencies`,
				"{request}",
				"Peak concurrent requests per container instance",
			),
			metric("sum", `${RUN}/container/billable_instance_time`, "s", "Billable container instance time"),
		],
	},
	{
		// Cloud Functions (1st gen).
		resourceType: "cloud_function",
		resourceLabels: ["function_name", "region"],
		metrics: [
			metric("sum", `${FUNCTIONS}/execution_count`, "{execution}", "Function executions", {
				labels: ["status"],
			}),
			// Reported in nanoseconds.
			metric("quantiles", `${FUNCTIONS}/execution_times`, "ms", "Function execution time", {
				scale: 1e-6,
			}),
			metric("gauge", `${FUNCTIONS}/instance_count`, "{instance}", "Function instances", {
				labels: ["state"],
			}),
			metric("quantiles", `${FUNCTIONS}/user_memory_bytes`, "By", "Peak memory used per execution"),
			metric("sum", `${FUNCTIONS}/network_egress`, "By", "Outgoing network traffic"),
		],
	},
	{
		// GKE workloads, one series per container name: pods are aggregated away.
		resourceType: "k8s_container",
		resourceLabels: ["cluster_name", "location", "namespace_name", "container_name"],
		metrics: [
			metric("sum", `${GKE}/container/cpu/core_usage_time`, "s", "CPU time used"),
			metric(
				"gauge",
				`${GKE}/container/cpu/limit_utilization`,
				"1",
				"Fraction of the CPU limit in use, averaged over pods",
				MEAN,
			),
			metric("gauge", `${GKE}/container/memory/used_bytes`, "By", "Memory in use", {
				labels: ["memory_type"],
			}),
			metric(
				"gauge",
				`${GKE}/container/memory/limit_utilization`,
				"1",
				"Fraction of the memory limit in use, averaged over pods",
				{ ...MEAN, labels: ["memory_type"] },
			),
			metric("sum", `${GKE}/container/restart_count`, "{restart}", "Container restarts"),
		],
	},
	{
		// GKE nodes, averaged per cluster: node names churn with autoscaling.
		resourceType: "k8s_node",
		resourceLabels: ["cluster_name", "location"],
		metrics: [
			metric(
				"gauge",
				`${GKE}/node/cpu/allocatable_utilization`,
				"1",
				"Fraction of allocatable CPU in use, averaged over nodes",
				MEAN,
			),
			metric(
				"gauge",
				`${GKE}/node/memory/allocatable_utilization`,
				"1",
				"Fraction of allocatable memory in use, averaged over nodes",
				{ ...MEAN, labels: ["memory_type"] },
			),
		],
	},
	{
		// Compute Engine VMs. `instance_name` is a metric label; it names the service.
		resourceType: "gce_instance",
		resourceLabels: ["instance_id", "zone"],
		metrics: [
			metric("gauge", `${GCE}/cpu/utilization`, "1", "Fraction of the allocated CPU in use", {
				...MEAN,
				...INSTANCE,
			}),
			// E2 machine types only.
			metric("gauge", `${GCE}/memory/balloon/ram_used`, "By", "Memory in use", INSTANCE),
			metric("sum", `${GCE}/network/received_bytes_count`, "By", "Bytes received", INSTANCE),
			metric("sum", `${GCE}/network/sent_bytes_count`, "By", "Bytes sent", INSTANCE),
			metric("sum", `${GCE}/disk/read_bytes_count`, "By", "Bytes read from disk", INSTANCE),
			metric("sum", `${GCE}/disk/write_bytes_count`, "By", "Bytes written to disk", INSTANCE),
		],
	},
	{
		resourceType: "cloudsql_database",
		resourceLabels: ["database_id", "region"],
		metrics: [
			metric("gauge", `${SQL}/cpu/utilization`, "1", "Fraction of the reserved CPU in use", MEAN),
			metric("gauge", `${SQL}/memory/utilization`, "1", "Fraction of the memory quota in use", MEAN),
			metric("gauge", `${SQL}/disk/utilization`, "1", "Fraction of the disk quota in use", MEAN),
			// MySQL and SQL Server.
			metric("gauge", `${SQL}/network/connections`, "{connection}", "Connections to the instance"),
			// PostgreSQL, summed over databases.
			metric("gauge", `${SQL}/postgresql/num_backends`, "{connection}", "Connections to the instance"),
			metric("sum", `${SQL}/disk/read_ops_count`, "{operation}", "Disk read operations"),
			metric("sum", `${SQL}/disk/write_ops_count`, "{operation}", "Disk write operations"),
			metric(
				"gauge",
				`${SQL}/replication/replica_lag`,
				"s",
				"How far a read replica is behind its primary",
				MEAN,
			),
		],
	},
	{
		resourceType: "pubsub_subscription",
		resourceLabels: ["subscription_id"],
		metrics: [
			metric(
				"gauge",
				`${PUBSUB}/subscription/num_undelivered_messages`,
				"{message}",
				"Unacknowledged messages",
			),
			metric(
				"gauge",
				`${PUBSUB}/subscription/oldest_unacked_message_age`,
				"s",
				"Age of the oldest unacknowledged message",
				MEAN,
			),
			metric(
				"sum",
				`${PUBSUB}/subscription/sent_message_count`,
				"{message}",
				"Messages sent to subscribers",
			),
			metric("sum", `${PUBSUB}/subscription/ack_message_count`, "{message}", "Messages acknowledged"),
			metric(
				"sum",
				`${PUBSUB}/subscription/push_request_count`,
				"{request}",
				"Push delivery attempts",
				{ labels: ["response_class"] },
			),
			metric(
				"sum",
				`${PUBSUB}/subscription/dead_letter_message_count`,
				"{message}",
				"Messages moved to the dead-letter topic",
			),
		],
	},
	{
		resourceType: "pubsub_topic",
		resourceLabels: ["topic_id"],
		metrics: [
			metric("sum", `${PUBSUB}/topic/send_request_count`, "{request}", "Publish requests", {
				labels: ["response_class"],
			}),
		],
	},
	{
		// Global external Application Load Balancers.
		resourceType: "https_lb_rule",
		resourceLabels: ["url_map_name", "backend_target_name"],
		metrics: [
			metric("sum", `${LB}/request_count`, "{request}", "Requests served", {
				labels: ["response_code_class"],
			}),
			metric(
				"quantiles",
				`${LB}/total_latencies`,
				"ms",
				"Latency from the request reaching the proxy to the last response byte",
			),
			metric(
				"quantiles",
				`${LB}/backend_latencies`,
				"ms",
				"Latency from the proxy sending the request to the backend to the last response byte",
			),
			metric("sum", `${LB}/backend_request_count`, "{request}", "Requests sent to backends", {
				labels: ["response_code_class"],
			}),
			metric("sum", `${LB}/request_bytes_count`, "By", "Request bytes received from clients"),
			metric("sum", `${LB}/response_bytes_count`, "By", "Response bytes sent to clients"),
		],
	},
]
