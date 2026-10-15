import { GCP_METRIC_GROUPS } from "@maple/domain/gcp-metrics"
import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_BAR,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	combineWhere,
	escapeMetricStringLiteral,
	metricsTimeseries,
	paramKey,
	paramValue,
	templateId,
} from "@maple/backend/dashboard-templates/helpers"
import type { TemplateDefinition, WidgetDef } from "@maple/backend/dashboard-templates/types"

// The Cloud Monitoring poller (GcpMetricsService) stores the metrics in `GCP_METRIC_GROUPS` at
// one-minute resolution, so a widget takes its metric type and unit from that table (types sharing
// a name share both). Counters are
// delta sums (`sum`, not rate). Gauges are averaged, over the bucket and over the regions a
// workload runs in: `sum` would add up every minute. Distributions are p50/p95/p99 gauges keyed
// by the `quantile` attribute. Workloads chart by `service.name`. A chart grouped by an attribute
// keeps one service's value per group, so those are used only where `service.name` is the
// constant `gcp/<resource type>` (see `gcpResourceAttributes`).
const STORED = new Map(
	GCP_METRIC_GROUPS.flatMap((group) => group.metrics.map((metric) => [metric.name, metric] as const)),
)

const DISPLAY_UNITS = new Map([
	["s", "duration_s"],
	["By", "bytes"],
	// Utilization is a 0-1 fraction, which is what `percent` expects.
	["1", "percent"],
])

const WORKLOAD = "service.name"
const label = (name: string) => `resource.gcp.resource.labels.${name}`
const metricLabel = (name: string) => `attr.gcp.metric.labels.${name}`
const P95 = `attr.quantile = "0.95"`

interface Chart {
	readonly id: string
	readonly title: string
	readonly metric: string
	readonly by: string
	readonly where?: string
	readonly display?: WidgetDef["display"]
}

const CHARTS: ReadonlyArray<Chart> = [
	// Cloud Run, and Cloud Functions (2nd gen), which run on it.
	{
		id: "run-requests",
		title: "Cloud Run Requests by Service",
		metric: "gcp.cloud_run.requests",
		by: WORKLOAD,
	},
	{
		id: "run-errors",
		title: "Cloud Run 5xx Responses by Service",
		metric: "gcp.cloud_run.requests",
		by: WORKLOAD,
		where: `${metricLabel("response_code_class")} = "5xx"`,
		display: CHART_DISPLAY_BAR,
	},
	{
		id: "run-latency",
		title: "Cloud Run Request Latency p95 by Service",
		metric: "gcp.cloud_run.request.duration",
		by: WORKLOAD,
		where: P95,
	},
	{
		id: "run-instances",
		title: "Cloud Run Active Instances by Service",
		metric: "gcp.cloud_run.container.instance.count",
		by: WORKLOAD,
		where: `${metricLabel("state")} = "active"`,
	},
	{
		id: "run-cpu",
		title: "Cloud Run CPU Utilization p95 by Service",
		metric: "gcp.cloud_run.container.cpu.utilization",
		by: WORKLOAD,
		where: P95,
	},
	{
		id: "run-memory",
		title: "Cloud Run Memory Utilization p95 by Service",
		metric: "gcp.cloud_run.container.memory.utilization",
		by: WORKLOAD,
		where: P95,
	},

	{
		id: "functions-executions",
		title: "Cloud Functions (1st gen) Executions by Function",
		metric: "gcp.cloud_functions.executions",
		by: WORKLOAD,
	},
	{
		id: "functions-execution-time",
		title: "Cloud Functions (1st gen) Execution Time p95 by Function",
		metric: "gcp.cloud_functions.execution.duration",
		by: WORKLOAD,
		where: P95,
	},

	{
		id: "gke-cpu",
		title: "GKE CPU Limit Utilization by Container",
		metric: "gcp.gke.container.cpu.limit.utilization",
		by: WORKLOAD,
	},
	{
		// The kernel reclaims evictable memory under pressure, so non-evictable is the one to watch.
		id: "gke-memory",
		title: "GKE Memory Limit Utilization by Container",
		metric: "gcp.gke.container.memory.limit.utilization",
		by: WORKLOAD,
		where: `${metricLabel("memory_type")} = "non-evictable"`,
	},
	{
		id: "gke-restarts",
		title: "GKE Container Restarts",
		metric: "gcp.gke.container.restarts",
		by: WORKLOAD,
		display: CHART_DISPLAY_BAR,
	},
	{
		id: "gke-node-cpu",
		title: "GKE Node CPU Utilization by Cluster",
		metric: "gcp.gke.node.cpu.allocatable.utilization",
		by: "resource.k8s.cluster.name",
	},

	{
		id: "compute-cpu",
		title: "Compute Engine CPU Utilization by Instance",
		metric: "gcp.gce.cpu.utilization",
		by: WORKLOAD,
	},
	{
		id: "compute-network-sent",
		title: "Compute Engine Network Bytes Sent by Instance",
		metric: "gcp.gce.network.io",
		by: WORKLOAD,
		where: `attr.network.io.direction = "transmit"`,
	},

	{
		id: "sql-cpu",
		title: "Cloud SQL CPU Utilization by Instance",
		metric: "gcp.cloud_sql.cpu.utilization",
		by: label("database_id"),
	},
	{
		id: "sql-memory",
		title: "Cloud SQL Memory Utilization by Instance",
		metric: "gcp.cloud_sql.memory.utilization",
		by: label("database_id"),
	},
	{
		id: "sql-connections",
		title: "Cloud SQL Connections by Instance",
		metric: "gcp.cloud_sql.connection.count",
		by: label("database_id"),
	},

	{
		id: "pubsub-backlog",
		title: "Pub/Sub Unacknowledged Messages by Subscription",
		metric: "gcp.pubsub.subscription.undelivered_messages",
		by: label("subscription_id"),
	},
	{
		id: "pubsub-oldest-unacked",
		title: "Pub/Sub Oldest Unacknowledged Message Age",
		metric: "gcp.pubsub.subscription.oldest_unacked_message.age",
		by: label("subscription_id"),
	},

	// Global external Application Load Balancers.
	{
		id: "lb-requests",
		title: "Load Balancer Requests by URL Map",
		metric: "gcp.load_balancing.requests",
		by: label("url_map_name"),
	},
	{
		id: "lb-response-classes",
		title: "Load Balancer Requests by Response Class",
		metric: "gcp.load_balancing.requests",
		by: metricLabel("response_code_class"),
	},
	{
		id: "lb-total-latency",
		title: "Load Balancer Total Latency p95 by URL Map",
		metric: "gcp.load_balancing.request.duration",
		by: label("url_map_name"),
		where: P95,
	},
	{
		id: "lb-backend-latency",
		title: "Load Balancer Backend Latency p95 by URL Map",
		metric: "gcp.load_balancing.backend.request.duration",
		by: label("url_map_name"),
		where: P95,
	},
]

function widgets(projectId?: string): WidgetDef[] {
	const project = projectId ? `resource.cloud.account.id = "${escapeMetricStringLiteral(projectId)}"` : ""
	return CHARTS.map((chart, index): WidgetDef => {
		// An unknown name still builds, so gcp.test.ts can report it by name.
		const stored = STORED.get(chart.metric)
		const counter = stored?.kind === "sum"
		return {
			id: chart.id,
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: chart.id,
				name: chart.title,
				metricName: chart.metric,
				metricType: counter ? "sum" : "gauge",
				aggregation: counter ? "sum" : "avg",
				whereClause: combineWhere(chart.where, project),
				groupBy: [chart.by],
			}),
			display: {
				title: chart.title,
				...(chart.display ?? (counter ? CHART_DISPLAY_AREA : CHART_DISPLAY_LINE)),
				unit: DISPLAY_UNITS.get(stored?.unit ?? "") ?? "number",
			},
			// Two charts per row, in list order.
			layout: { x: (index % 2) * 6, y: Math.floor(index / 2) * 6, w: 6, h: 6 },
		}
	})
}

export const gcpTemplate: TemplateDefinition = {
	id: templateId("gcp"),
	name: "Google Cloud",
	description:
		"Metrics from the Google Cloud integration: Cloud Run requests, errors, latency and instances, Cloud Functions (1st gen) executions, GKE container and node utilization, Compute Engine CPU and network, Cloud SQL utilization and connections, Pub/Sub backlog, and load balancer requests and latency.",
	category: "infrastructure",
	tags: ["gcp", "google cloud", "cloud run", "gke", "cloud sql", "pubsub"],
	requirement: {
		kind: "integration",
		label: "Google Cloud integration connected with Metrics and resources switched on",
		collector: "the Google Cloud integration with Metrics and resources switched on",
		setupLabel: "the Google Cloud integration",
		hint: "Connect a project, folder or organization, switch on Metrics and resources and run the setup script. Each widget fills in once its service reports.",
	},
	requiredMetricPrefixes: ["gcp."],
	parameters: [
		{
			key: paramKey("project_id"),
			label: "Project ID",
			description: "Optional. Scope every widget to one Google Cloud project.",
			required: false,
			placeholder: "acme-prod",
		},
	],
	build: (params) => {
		const projectId = paramValue(params, "project_id")
		return buildPortableDashboard({
			name: projectId ? `Google Cloud (${projectId})` : "Google Cloud",
			description:
				"Cloud Run, Cloud Functions, GKE, Compute Engine, Cloud SQL, Pub/Sub and load balancer metrics from Cloud Monitoring.",
			tags: ["gcp"],
			timeRange: "24h",
			widgets: widgets(projectId),
		})
	},
}
