/**
 * What Maple collects from a connected Google Cloud project, folder or organization. The metric
 * table is the whole metrics scope: the poller issues one `timeSeries.list` query per entry, and
 * anything that charts Google Cloud metrics reads the Maple names from here.
 *
 * Cloud Monitoring aligns every series to 60 seconds and reduces it to the project, the group's
 * `resourceLabels` and `resourceMetricLabels`, and the metric's `labels`; every other label
 * (revision, pod, response code, device) is aggregated away before it reaches Maple, which is what
 * bounds cardinality.
 *
 * Names follow the OpenTelemetry semantic conventions' naming rules under the `gcp.` vendor
 * namespace: durations in seconds, byte counters as `.io` split by the semconv direction attribute.
 * Two types can share a name when they differ by a constant attribute, or report the same thing
 * for different engines.
 */

export interface GcpMetric {
	/** Cloud Monitoring metric type. */
	readonly type: string
	/** Metric name in Maple, e.g. `gcp.cloud_run.request.duration`. */
	readonly name: string
	/**
	 * What Maple stores: `sum` is a delta counter per minute, `gauge` a sampled value, and
	 * `quantiles` are p50/p95/p99 gauges (attribute `quantile`) of a distribution summed over the
	 * group. A gauge is aligned by mean, the other two as deltas. A `sum` of a distribution counts
	 * its values.
	 */
	readonly kind: "sum" | "gauge" | "quantiles"
	readonly unit: string
	readonly description: string
	/** How the series a group folds together are combined. */
	readonly reducer: "REDUCE_SUM" | "REDUCE_MEAN"
	/** Metric labels kept on every point as `gcp.metric.labels.<label>`. */
	readonly labels: ReadonlyArray<string>
	/** Attributes every point carries, e.g. the direction of a byte counter. */
	readonly attributes: Readonly<Record<string, string>>
	/** Multiplier from the Cloud Monitoring unit to `unit`. */
	readonly scale: number
}

export interface GcpMetricGroup {
	/** Monitored resource type the series are read from. */
	readonly resourceType: string
	/** Resource labels each series keeps; they become the resource attributes. */
	readonly resourceLabels: ReadonlyArray<string>
	/** Metric labels each series keeps that name the resource: resource attributes, not point ones. */
	readonly resourceMetricLabels: ReadonlyArray<string>
	/**
	 * The resource type whose workloads the series are stored under, when it is not their own: a
	 * Cloud SQL instance's Query Insights are stored as the instance.
	 */
	readonly workloadOf?: string
	/**
	 * Series too many to keep, one per item (`label`, a metric label every metric of the group
	 * keeps): each poll keeps the `limit` items of each resource with the largest total of the
	 * metric named `by`, and reads the group aligned over the whole poll window, one point per poll.
	 */
	readonly top?: { readonly by: string; readonly label: string; readonly limit: number }
	readonly metrics: ReadonlyArray<GcpMetric>
}

export const gcpMetricAligner = (metric: GcpMetric) =>
	metric.kind === "gauge" ? "ALIGN_MEAN" : "ALIGN_DELTA"

/** Labels stored under an OpenTelemetry attribute rather than `gcp.metric.labels.<label>`. */
const LABEL_ATTRIBUTES = new Map([["querystring", "db.query.text"]])

/** The attribute a kept Cloud Monitoring metric label is stored as. */
export const gcpMetricLabelAttribute = (label: string) =>
	LABEL_ATTRIBUTES.get(label) ?? `gcp.metric.labels.${label}`

/** The attributes, besides `quantile`, that tell a metric's points apart. */
export const gcpMetricPointAttributes = (metric: GcpMetric): ReadonlyArray<string> => [
	...metric.labels.map(gcpMetricLabelAttribute),
	...Object.keys(metric.attributes),
]

const metric = (
	kind: GcpMetric["kind"],
	type: string,
	name: string,
	unit: string,
	description: string,
	options: Partial<Pick<GcpMetric, "reducer" | "labels" | "attributes" | "scale">> = {},
): GcpMetric => ({
	type,
	name,
	kind,
	unit,
	description,
	reducer: "REDUCE_SUM",
	labels: [],
	attributes: {},
	scale: 1,
	...options,
})

const MEAN = { reducer: "REDUCE_MEAN" } as const
const RECEIVE = { attributes: { "network.io.direction": "receive" } } as const
const TRANSMIT = { attributes: { "network.io.direction": "transmit" } } as const
const READ = { attributes: { "disk.io.direction": "read" } } as const
const WRITE = { attributes: { "disk.io.direction": "write" } } as const
// Cloud Monitoring reports these latencies in milliseconds, Query Insights in microseconds.
const FROM_MS = { scale: 1e-3 } as const
const FROM_US = { scale: 1e-6 } as const

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
const INSIGHTS = `${SQL}/postgresql/insights/aggregate`
const PER_QUERY = `${SQL}/postgresql/insights/perquery`
const PUBSUB = "pubsub.googleapis.com"
const LB = "loadbalancing.googleapis.com/https"

export const GCP_METRIC_GROUPS: ReadonlyArray<GcpMetricGroup> = [
	{
		// Cloud Run services, and Cloud Functions (2nd gen), which run on Cloud Run.
		resourceType: "cloud_run_revision",
		resourceLabels: ["service_name", "location"],
		resourceMetricLabels: [],
		metrics: [
			metric(
				"sum",
				`${RUN}/request_count`,
				"gcp.cloud_run.requests",
				"{request}",
				"Requests that reached the service",
				{ labels: ["response_code_class"] },
			),
			metric(
				"quantiles",
				`${RUN}/request_latencies`,
				"gcp.cloud_run.request.duration",
				"s",
				"Request latency",
				FROM_MS,
			),
			metric(
				"gauge",
				`${RUN}/container/instance_count`,
				"gcp.cloud_run.container.instance.count",
				"{instance}",
				"Container instances",
				{ labels: ["state"] },
			),
			metric(
				"quantiles",
				`${RUN}/container/cpu/utilizations`,
				"gcp.cloud_run.container.cpu.utilization",
				"1",
				"CPU utilization across container instances",
			),
			metric(
				"quantiles",
				`${RUN}/container/memory/utilizations`,
				"gcp.cloud_run.container.memory.utilization",
				"1",
				"Memory utilization across container instances",
			),
			metric(
				"quantiles",
				`${RUN}/container/max_request_concurrencies`,
				"gcp.cloud_run.container.request.max_concurrency",
				"{request}",
				"Peak concurrent requests per container instance",
			),
			metric(
				"sum",
				`${RUN}/container/billable_instance_time`,
				"gcp.cloud_run.container.billable_time",
				"s",
				"Billable container instance time",
			),
		],
	},
	{
		// Cloud Functions (1st gen).
		resourceType: "cloud_function",
		resourceLabels: ["function_name", "region"],
		resourceMetricLabels: [],
		metrics: [
			metric(
				"sum",
				`${FUNCTIONS}/execution_count`,
				"gcp.cloud_functions.executions",
				"{execution}",
				"Function executions",
				{ labels: ["status"] },
			),
			metric(
				"quantiles",
				`${FUNCTIONS}/execution_times`,
				"gcp.cloud_functions.execution.duration",
				"s",
				"Function execution time",
				// Reported in nanoseconds.
				{ scale: 1e-9 },
			),
			metric(
				"gauge",
				`${FUNCTIONS}/instance_count`,
				"gcp.cloud_functions.instance.count",
				"{instance}",
				"Function instances",
				{ labels: ["state"] },
			),
			metric(
				"quantiles",
				`${FUNCTIONS}/user_memory_bytes`,
				"gcp.cloud_functions.memory.usage",
				"By",
				"Peak memory used per execution",
			),
			metric(
				"sum",
				`${FUNCTIONS}/network_egress`,
				"gcp.cloud_functions.network.io",
				"By",
				"Outgoing network traffic",
				TRANSMIT,
			),
		],
	},
	{
		// GKE workloads, one series per container name: pods are aggregated away.
		resourceType: "k8s_container",
		resourceLabels: ["cluster_name", "location", "namespace_name", "container_name"],
		resourceMetricLabels: [],
		metrics: [
			metric(
				"sum",
				`${GKE}/container/cpu/core_usage_time`,
				"gcp.gke.container.cpu.time",
				"s",
				"CPU time used",
			),
			metric(
				"gauge",
				`${GKE}/container/cpu/limit_utilization`,
				"gcp.gke.container.cpu.limit.utilization",
				"1",
				"Fraction of the CPU limit in use, averaged over pods",
				MEAN,
			),
			metric(
				"gauge",
				`${GKE}/container/memory/used_bytes`,
				"gcp.gke.container.memory.usage",
				"By",
				"Memory in use",
				{ labels: ["memory_type"] },
			),
			metric(
				"gauge",
				`${GKE}/container/memory/limit_utilization`,
				"gcp.gke.container.memory.limit.utilization",
				"1",
				"Fraction of the memory limit in use, averaged over pods",
				{ ...MEAN, labels: ["memory_type"] },
			),
			metric(
				"sum",
				`${GKE}/container/restart_count`,
				"gcp.gke.container.restarts",
				"{restart}",
				"Container restarts",
			),
		],
	},
	{
		// GKE nodes, averaged per cluster: node names churn with autoscaling.
		resourceType: "k8s_node",
		resourceLabels: ["cluster_name", "location"],
		resourceMetricLabels: [],
		metrics: [
			metric(
				"gauge",
				`${GKE}/node/cpu/allocatable_utilization`,
				"gcp.gke.node.cpu.allocatable.utilization",
				"1",
				"Fraction of allocatable CPU in use, averaged over nodes",
				MEAN,
			),
			metric(
				"gauge",
				`${GKE}/node/memory/allocatable_utilization`,
				"gcp.gke.node.memory.allocatable.utilization",
				"1",
				"Fraction of allocatable memory in use, averaged over nodes",
				{ ...MEAN, labels: ["memory_type"] },
			),
		],
	},
	{
		// Compute Engine VMs.
		resourceType: "gce_instance",
		resourceLabels: ["instance_id", "zone"],
		// A metric label on Compute Engine metrics; it names the host and the service.
		resourceMetricLabels: ["instance_name"],
		metrics: [
			metric(
				"gauge",
				`${GCE}/cpu/utilization`,
				"gcp.gce.cpu.utilization",
				"1",
				"Fraction of the allocated CPU in use",
				MEAN,
			),
			// E2 machine types only.
			metric("gauge", `${GCE}/memory/balloon/ram_used`, "gcp.gce.memory.usage", "By", "Memory in use"),
			metric(
				"sum",
				`${GCE}/network/received_bytes_count`,
				"gcp.gce.network.io",
				"By",
				"Network traffic",
				RECEIVE,
			),
			metric(
				"sum",
				`${GCE}/network/sent_bytes_count`,
				"gcp.gce.network.io",
				"By",
				"Network traffic",
				TRANSMIT,
			),
			metric("sum", `${GCE}/disk/read_bytes_count`, "gcp.gce.disk.io", "By", "Disk traffic", READ),
			metric("sum", `${GCE}/disk/write_bytes_count`, "gcp.gce.disk.io", "By", "Disk traffic", WRITE),
		],
	},
	{
		resourceType: "cloudsql_database",
		resourceLabels: ["database_id", "region"],
		resourceMetricLabels: [],
		metrics: [
			metric(
				"gauge",
				`${SQL}/cpu/utilization`,
				"gcp.cloud_sql.cpu.utilization",
				"1",
				"Fraction of the reserved CPU in use",
				MEAN,
			),
			metric(
				"gauge",
				`${SQL}/memory/utilization`,
				"gcp.cloud_sql.memory.utilization",
				"1",
				"Fraction of the memory quota in use",
				MEAN,
			),
			metric(
				"gauge",
				`${SQL}/disk/utilization`,
				"gcp.cloud_sql.disk.utilization",
				"1",
				"Fraction of the disk quota in use",
				MEAN,
			),
			// MySQL and SQL Server. An instance runs one engine, so it reports this one or the next.
			metric(
				"gauge",
				`${SQL}/network/connections`,
				"gcp.cloud_sql.connection.count",
				"{connection}",
				"Connections to the instance",
			),
			// PostgreSQL, summed over databases.
			metric(
				"gauge",
				`${SQL}/postgresql/num_backends`,
				"gcp.cloud_sql.connection.count",
				"{connection}",
				"Connections to the instance",
			),
			metric(
				"sum",
				`${SQL}/disk/read_ops_count`,
				"gcp.cloud_sql.disk.operations",
				"{operation}",
				"Disk operations",
				READ,
			),
			metric(
				"sum",
				`${SQL}/disk/write_ops_count`,
				"gcp.cloud_sql.disk.operations",
				"{operation}",
				"Disk operations",
				WRITE,
			),
			metric(
				"gauge",
				`${SQL}/replication/replica_lag`,
				"gcp.cloud_sql.replication.lag",
				"s",
				"How far a read replica is behind its primary",
				MEAN,
			),
			metric("gauge", `${SQL}/memory/total_usage`, "gcp.cloud_sql.memory.usage", "By", "Memory in use"),
			metric("gauge", `${SQL}/disk/bytes_used`, "gcp.cloud_sql.disk.usage", "By", "Disk space in use"),
			metric("gauge", `${SQL}/disk/quota`, "gcp.cloud_sql.disk.limit", "By", "Disk quota"),
			// PostgreSQL, per database: the instance's database names.
			metric(
				"gauge",
				`${SQL}/postgresql/num_backends_by_state`,
				"gcp.cloud_sql.postgresql.connection.count",
				"{connection}",
				"PostgreSQL connections by state and database",
				{ labels: ["state", "database"] },
			),
			metric(
				"sum",
				`${SQL}/postgresql/deadlock_count`,
				"gcp.cloud_sql.postgresql.deadlocks",
				"{deadlock}",
				"Deadlocks",
			),
			metric(
				"gauge",
				`${SQL}/postgresql/transaction_id_utilization`,
				"gcp.cloud_sql.postgresql.transaction_id.utilization",
				"1",
				"Fraction of transaction IDs in use before wraparound",
				MEAN,
			),
			// `source` is `disk` or `buffer_cache`: the cache hit ratio.
			metric(
				"sum",
				`${SQL}/postgresql/blocks_read_count`,
				"gcp.cloud_sql.postgresql.block_reads",
				"{block}",
				"Data blocks read",
				{ labels: ["source"] },
			),
			metric(
				"sum",
				`${SQL}/postgresql/temp_bytes_written_count`,
				"gcp.cloud_sql.postgresql.temp_file.io",
				"By",
				"Bytes written to temporary files",
				WRITE,
			),
			metric(
				"sum",
				`${SQL}/mysql/slow_queries_count`,
				"gcp.cloud_sql.mysql.slow_queries",
				"{query}",
				"Queries slower than long_query_time",
			),
		],
	},
	{
		// PostgreSQL Query Insights, summed over the instance's databases, users and clients. Empty
		// while Query Insights is off.
		resourceType: "cloudsql_instance_database",
		resourceLabels: ["resource_id", "location"],
		resourceMetricLabels: [],
		workloadOf: "cloudsql_database",
		metrics: [
			metric(
				"quantiles",
				`${INSIGHTS}/latencies`,
				"gcp.cloud_sql.query.duration",
				"s",
				"Query latency",
				FROM_US,
			),
			metric("sum", `${INSIGHTS}/latencies`, "gcp.cloud_sql.queries", "{query}", "Queries run"),
			metric(
				"sum",
				`${INSIGHTS}/execution_time`,
				"gcp.cloud_sql.query.execution.time",
				"s",
				"Query execution time: CPU, I/O wait, lock wait and scheduling",
				FROM_US,
			),
			metric(
				"sum",
				`${INSIGHTS}/io_time`,
				"gcp.cloud_sql.query.io.time",
				"s",
				"Time queries spent waiting on I/O",
				FROM_US,
			),
			metric(
				"sum",
				`${INSIGHTS}/lock_time`,
				"gcp.cloud_sql.query.lock.time",
				"s",
				"Time queries spent waiting on locks",
				FROM_US,
			),
		],
	},
	{
		// The same per normalized statement, summed over databases, users and clients: the 25
		// statements of each instance that ran longest in the poll window. A statement outside them
		// in a window is not stored for it.
		resourceType: "cloudsql_instance_database",
		resourceLabels: ["resource_id", "location"],
		resourceMetricLabels: [],
		top: { by: "gcp.cloud_sql.query.statement.execution.time", label: "query_hash", limit: 25 },
		metrics: [
			// The statement's text once, on the metric that ranks it.
			metric(
				"sum",
				`${PER_QUERY}/execution_time`,
				"gcp.cloud_sql.query.statement.execution.time",
				"s",
				"Execution time of one statement: CPU, I/O wait, lock wait and scheduling",
				{ ...FROM_US, labels: ["query_hash", "querystring"] },
			),
			metric(
				"quantiles",
				`${PER_QUERY}/latencies`,
				"gcp.cloud_sql.query.statement.duration",
				"s",
				"Latency of one statement",
				{ ...FROM_US, labels: ["query_hash"] },
			),
			metric(
				"sum",
				`${PER_QUERY}/latencies`,
				"gcp.cloud_sql.query.statement.calls",
				"{call}",
				"Calls of one statement",
				{ labels: ["query_hash"] },
			),
			metric(
				"sum",
				`${PER_QUERY}/lock_time`,
				"gcp.cloud_sql.query.statement.lock.time",
				"s",
				"Time one statement spent waiting on locks",
				{ ...FROM_US, labels: ["query_hash"] },
			),
			metric(
				"sum",
				`${PER_QUERY}/io_time`,
				"gcp.cloud_sql.query.statement.io.time",
				"s",
				"Time one statement spent waiting on I/O",
				{ ...FROM_US, labels: ["query_hash"] },
			),
			metric(
				"sum",
				`${PER_QUERY}/row_count`,
				"gcp.cloud_sql.query.statement.rows",
				"{row}",
				"Rows one statement retrieved or affected",
				{ labels: ["query_hash"] },
			),
		],
	},
	{
		resourceType: "pubsub_subscription",
		resourceLabels: ["subscription_id"],
		resourceMetricLabels: [],
		metrics: [
			metric(
				"gauge",
				`${PUBSUB}/subscription/num_undelivered_messages`,
				"gcp.pubsub.subscription.undelivered_messages",
				"{message}",
				"Unacknowledged messages",
			),
			metric(
				"gauge",
				`${PUBSUB}/subscription/oldest_unacked_message_age`,
				"gcp.pubsub.subscription.oldest_unacked_message.age",
				"s",
				"Age of the oldest unacknowledged message",
				MEAN,
			),
			metric(
				"sum",
				`${PUBSUB}/subscription/sent_message_count`,
				"gcp.pubsub.subscription.sent_messages",
				"{message}",
				"Messages sent to subscribers",
			),
			metric(
				"sum",
				`${PUBSUB}/subscription/ack_message_count`,
				"gcp.pubsub.subscription.acked_messages",
				"{message}",
				"Messages acknowledged",
			),
			metric(
				"sum",
				`${PUBSUB}/subscription/push_request_count`,
				"gcp.pubsub.subscription.push_requests",
				"{request}",
				"Push delivery attempts",
				{ labels: ["response_class"] },
			),
			metric(
				"sum",
				`${PUBSUB}/subscription/dead_letter_message_count`,
				"gcp.pubsub.subscription.dead_lettered_messages",
				"{message}",
				"Messages moved to the dead-letter topic",
			),
		],
	},
	{
		resourceType: "pubsub_topic",
		resourceLabels: ["topic_id"],
		resourceMetricLabels: [],
		metrics: [
			metric(
				"sum",
				`${PUBSUB}/topic/send_request_count`,
				"gcp.pubsub.topic.publish_requests",
				"{request}",
				"Publish requests",
				{ labels: ["response_class"] },
			),
		],
	},
	{
		// Global external Application Load Balancers.
		resourceType: "https_lb_rule",
		resourceLabels: ["url_map_name", "backend_target_name"],
		resourceMetricLabels: [],
		metrics: [
			metric(
				"sum",
				`${LB}/request_count`,
				"gcp.load_balancing.requests",
				"{request}",
				"Requests served",
				{ labels: ["response_code_class"] },
			),
			metric(
				"quantiles",
				`${LB}/total_latencies`,
				"gcp.load_balancing.request.duration",
				"s",
				"Latency from the request reaching the proxy to the last response byte",
				FROM_MS,
			),
			metric(
				"quantiles",
				`${LB}/backend_latencies`,
				"gcp.load_balancing.backend.request.duration",
				"s",
				"Latency from the proxy sending the request to the backend to the last response byte",
				FROM_MS,
			),
			metric(
				"sum",
				`${LB}/backend_request_count`,
				"gcp.load_balancing.backend.requests",
				"{request}",
				"Requests sent to backends",
				{ labels: ["response_code_class"] },
			),
			metric(
				"sum",
				`${LB}/request_bytes_count`,
				"gcp.load_balancing.network.io",
				"By",
				"Bytes exchanged with clients",
				RECEIVE,
			),
			metric(
				"sum",
				`${LB}/response_bytes_count`,
				"gcp.load_balancing.network.io",
				"By",
				"Bytes exchanged with clients",
				TRANSMIT,
			),
		],
	},
]
