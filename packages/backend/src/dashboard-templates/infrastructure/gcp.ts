import { GCP_METRIC_GROUPS, type GcpMetricGroup } from "@maple/domain/gcp-metrics"
import type { DashboardVariable } from "@maple/domain/http"
import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_BAR,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	combineWhere,
	metricsTimeseries,
	paramKey,
	paramValue,
	templateId,
} from "@maple/backend/dashboard-templates/helpers"
import type { TemplateDefinition, WidgetDef } from "@maple/backend/dashboard-templates/types"

// The Cloud Monitoring poller (GcpMetricsService) stores the metrics in `GCP_METRIC_GROUPS` at
// one-minute resolution, so a widget takes its metric type and unit from that table (types sharing
// a name share both). Counters are delta sums (`sum`, not rate). Gauges are averaged, over the bucket and over the regions a
// workload runs in: `sum` would add up every minute. Distributions are p50/p95/p99 gauges keyed
// by the `quantile` attribute. Workloads chart by `service.name`. A chart grouped by an attribute
// keeps one service's value per group, so those are used only where `service.name` is the
// constant `gcp/<resource type>` (see `gcpResourceAttributes`).
const GROUP_BY_METRIC = new Map(
	GCP_METRIC_GROUPS.flatMap((group) => group.metrics.map((metric) => [metric.name, group] as const)),
)
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
const NON_EVICTABLE = `${metricLabel("memory_type")} = "non-evictable"`
const ACTIVE = `${metricLabel("state")} = "active"`
const P95 = `attr.quantile = "0.95"`

// `cloud.region` is set only for resources Cloud Monitoring labels with a location.
const isRegional = (group: GcpMetricGroup) =>
	group.resourceLabels.some((name) => name === "location" || name === "region" || name === "zone")

// Resource types whose `service.name` is a workload rather than `gcp/<resource type>`.
const WORKLOAD_RESOURCES = new Set(["cloud_run_revision", "cloud_function", "k8s_container", "gce_instance"])

/**
 * A variable listing a resource attribute's values from one gauge per resource type, so every
 * project, region or workload the poller has stored shows up. Gauges, because only they live in
 * one table across every group (distributions are stored as quantile gauges).
 */
function resourceVariable(opts: {
	readonly name: string
	readonly label: string
	readonly attributeKey: string
	readonly groups: ReadonlyArray<GcpMetricGroup>
	readonly defaultValue?: string
}): DashboardVariable {
	return {
		name: opts.name,
		label: opts.label,
		type: "query",
		includeAll: true,
		...(opts.defaultValue && { defaultValue: opts.defaultValue }),
		source: {
			kind: "metric",
			metricType: "gauge",
			metricNames: opts.groups.flatMap(
				(group) => group.metrics.find((metric) => metric.kind !== "sum")?.name ?? [],
			),
			scope: "resource",
			attributeKey: opts.attributeKey,
		},
	}
}

const PROJECT_FILTER = `resource.cloud.account.id = "$project"`
const REGION_FILTER = `resource.cloud.region = "$region"`
const WORKLOAD_FILTER = `service.name = "$workload"`

interface Chart {
	readonly id: string
	readonly title: string
	readonly metric: string
	readonly by: string
	readonly where?: string
	readonly display?: WidgetDef["display"]
}

interface Tab {
	readonly id: string
	readonly title: string
	readonly charts: ReadonlyArray<Chart>
}

const TABS: ReadonlyArray<Tab> = [
	{
		// Cloud Run, and Cloud Functions (2nd gen), which run on it.
		id: "cloud-run",
		title: "Cloud Run",
		charts: [
			{
				id: "run-requests",
				title: "Requests by Service",
				metric: "gcp.cloud_run.requests",
				by: WORKLOAD,
			},
			{
				id: "run-errors",
				title: "5xx Responses by Service",
				metric: "gcp.cloud_run.requests",
				by: WORKLOAD,
				where: `${metricLabel("response_code_class")} = "5xx"`,
				display: CHART_DISPLAY_BAR,
			},
			{
				id: "run-latency",
				title: "Request Latency p95 by Service",
				metric: "gcp.cloud_run.request.duration",
				by: WORKLOAD,
				where: P95,
			},
			{
				id: "run-instances",
				title: "Active Instances by Service",
				metric: "gcp.cloud_run.container.instance.count",
				by: WORKLOAD,
				where: ACTIVE,
			},
			{
				id: "run-cpu",
				title: "CPU Utilization p95 by Service",
				metric: "gcp.cloud_run.container.cpu.utilization",
				by: WORKLOAD,
				where: P95,
			},
			{
				id: "run-memory",
				title: "Memory Utilization p95 by Service",
				metric: "gcp.cloud_run.container.memory.utilization",
				by: WORKLOAD,
				where: P95,
			},
		],
	},
	{
		id: "cloud-functions",
		title: "Cloud Functions (1st gen)",
		charts: [
			{
				id: "functions-executions",
				title: "Executions by Function",
				metric: "gcp.cloud_functions.executions",
				by: WORKLOAD,
			},
			{
				id: "functions-execution-time",
				title: "Execution Time p95 by Function",
				metric: "gcp.cloud_functions.execution.duration",
				by: WORKLOAD,
				where: P95,
			},
			{
				id: "functions-instances",
				title: "Active Instances by Function",
				metric: "gcp.cloud_functions.instance.count",
				by: WORKLOAD,
				where: ACTIVE,
			},
			{
				id: "functions-memory",
				title: "Peak Memory per Execution p95 by Function",
				metric: "gcp.cloud_functions.memory.usage",
				by: WORKLOAD,
				where: P95,
			},
		],
	},
	{
		id: "gke",
		title: "GKE",
		charts: [
			{
				id: "gke-cpu",
				title: "CPU Limit Utilization by Container",
				metric: "gcp.gke.container.cpu.limit.utilization",
				by: WORKLOAD,
			},
			{
				// The kernel reclaims evictable memory under pressure, so non-evictable is the one to watch.
				id: "gke-memory",
				title: "Memory Limit Utilization by Container",
				metric: "gcp.gke.container.memory.limit.utilization",
				by: WORKLOAD,
				where: NON_EVICTABLE,
			},
			{
				id: "gke-restarts",
				title: "Container Restarts",
				metric: "gcp.gke.container.restarts",
				by: WORKLOAD,
				display: CHART_DISPLAY_BAR,
			},
			{
				id: "gke-memory-used",
				title: "Memory in Use by Container",
				metric: "gcp.gke.container.memory.usage",
				by: WORKLOAD,
				where: NON_EVICTABLE,
			},
			{
				id: "gke-node-cpu",
				title: "Node CPU Utilization by Cluster",
				metric: "gcp.gke.node.cpu.allocatable.utilization",
				by: "resource.k8s.cluster.name",
			},
			{
				id: "gke-node-memory",
				title: "Node Memory Utilization by Cluster",
				metric: "gcp.gke.node.memory.allocatable.utilization",
				by: "resource.k8s.cluster.name",
				where: NON_EVICTABLE,
			},
		],
	},
	{
		id: "compute-engine",
		title: "Compute Engine",
		charts: [
			{
				id: "compute-cpu",
				title: "CPU Utilization by Instance",
				metric: "gcp.gce.cpu.utilization",
				by: WORKLOAD,
			},
			{
				id: "compute-memory",
				title: "Memory in Use by Instance (E2)",
				metric: "gcp.gce.memory.usage",
				by: WORKLOAD,
			},
			{
				id: "compute-network-received",
				title: "Network Bytes Received by Instance",
				metric: "gcp.gce.network.io",
				by: WORKLOAD,
				where: `attr.network.io.direction = "receive"`,
			},
			{
				id: "compute-network-sent",
				title: "Network Bytes Sent by Instance",
				metric: "gcp.gce.network.io",
				by: WORKLOAD,
				where: `attr.network.io.direction = "transmit"`,
			},
			{
				id: "compute-disk-read",
				title: "Disk Bytes Read by Instance",
				metric: "gcp.gce.disk.io",
				by: WORKLOAD,
				where: `attr.disk.io.direction = "read"`,
			},
			{
				id: "compute-disk-write",
				title: "Disk Bytes Written by Instance",
				metric: "gcp.gce.disk.io",
				by: WORKLOAD,
				where: `attr.disk.io.direction = "write"`,
			},
		],
	},
	{
		id: "cloud-sql",
		title: "Cloud SQL",
		charts: [
			{
				id: "sql-cpu",
				title: "CPU Utilization by Instance",
				metric: "gcp.cloud_sql.cpu.utilization",
				by: label("database_id"),
			},
			{
				id: "sql-memory",
				title: "Memory Utilization by Instance",
				metric: "gcp.cloud_sql.memory.utilization",
				by: label("database_id"),
			},
			{
				id: "sql-connections",
				title: "Connections by Instance",
				metric: "gcp.cloud_sql.connection.count",
				by: label("database_id"),
			},
			{
				id: "sql-disk-operations",
				title: "Disk Operations by Instance",
				metric: "gcp.cloud_sql.disk.operations",
				by: label("database_id"),
			},
			{
				id: "sql-disk",
				title: "Disk Utilization by Instance",
				metric: "gcp.cloud_sql.disk.utilization",
				by: label("database_id"),
			},
			{
				id: "sql-replica-lag",
				title: "Replica Lag by Instance",
				metric: "gcp.cloud_sql.replication.lag",
				by: label("database_id"),
			},
		],
	},
	{
		id: "pubsub",
		title: "Pub/Sub",
		charts: [
			{
				id: "pubsub-backlog",
				title: "Unacknowledged Messages by Subscription",
				metric: "gcp.pubsub.subscription.undelivered_messages",
				by: label("subscription_id"),
			},
			{
				id: "pubsub-oldest-unacked",
				title: "Oldest Unacknowledged Message Age",
				metric: "gcp.pubsub.subscription.oldest_unacked_message.age",
				by: label("subscription_id"),
			},
			{
				id: "pubsub-sent",
				title: "Messages Sent by Subscription",
				metric: "gcp.pubsub.subscription.sent_messages",
				by: label("subscription_id"),
			},
			{
				id: "pubsub-acked",
				title: "Messages Acknowledged by Subscription",
				metric: "gcp.pubsub.subscription.acked_messages",
				by: label("subscription_id"),
			},
			{
				id: "pubsub-dead-lettered",
				title: "Dead-Lettered Messages by Subscription",
				metric: "gcp.pubsub.subscription.dead_lettered_messages",
				by: label("subscription_id"),
				display: CHART_DISPLAY_BAR,
			},
			{
				id: "pubsub-publish-requests",
				title: "Publish Requests by Topic",
				metric: "gcp.pubsub.topic.publish_requests",
				by: label("topic_id"),
			},
		],
	},
	{
		// Global external Application Load Balancers.
		id: "load-balancing",
		title: "Load Balancing",
		charts: [
			{
				id: "lb-requests",
				title: "Requests by URL Map",
				metric: "gcp.load_balancing.requests",
				by: label("url_map_name"),
			},
			{
				id: "lb-response-classes",
				title: "Requests by Response Class",
				metric: "gcp.load_balancing.requests",
				by: metricLabel("response_code_class"),
			},
			{
				id: "lb-total-latency",
				title: "Total Latency p95 by URL Map",
				metric: "gcp.load_balancing.request.duration",
				by: label("url_map_name"),
				where: P95,
			},
			{
				id: "lb-backend-latency",
				title: "Backend Latency p95 by URL Map",
				metric: "gcp.load_balancing.backend.request.duration",
				by: label("url_map_name"),
				where: P95,
			},
		],
	},
]

const SECTION_ID = "gcp-services"

function widget(tab: Tab, chart: Chart, index: number): WidgetDef {
	// An unknown name still builds, so gcp.test.ts can report it by name.
	const stored = STORED.get(chart.metric)
	const group = GROUP_BY_METRIC.get(chart.metric)
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
			// A variable left on "All" drops its clause.
			whereClause: combineWhere(
				chart.where,
				PROJECT_FILTER,
				group && isRegional(group) ? REGION_FILTER : undefined,
				chart.by === WORKLOAD ? WORKLOAD_FILTER : undefined,
			),
			groupBy: [chart.by],
		}),
		display: {
			title: chart.title,
			...(chart.display ?? (counter ? CHART_DISPLAY_AREA : CHART_DISPLAY_LINE)),
			unit: DISPLAY_UNITS.get(stored?.unit ?? "") ?? "number",
		},
		// Two charts per row, in list order, within the tab.
		layout: { x: (index % 2) * 6, y: Math.floor(index / 2) * 6, w: 6, h: 6 },
		sectionId: SECTION_ID,
		tabId: tab.id,
	}
}

export const gcpTemplate: TemplateDefinition = {
	id: templateId("gcp"),
	name: "Google Cloud",
	description:
		"Metrics from the Google Cloud integration, one tab per service: Cloud Run requests, errors, latency and instances, Cloud Functions (1st gen) executions, GKE container and node utilization, Compute Engine CPU, memory, network and disk, Cloud SQL utilization, connections and replica lag, Pub/Sub backlog and throughput, and load balancer requests and latency. Filter by project, region and workload.",
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
			description:
				"Optional. The project the Project filter starts on; it can be changed on the dashboard.",
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
			variables: [
				resourceVariable({
					name: "project",
					label: "Project",
					attributeKey: "cloud.account.id",
					groups: GCP_METRIC_GROUPS,
					defaultValue: projectId,
				}),
				resourceVariable({
					name: "region",
					label: "Region",
					attributeKey: "cloud.region",
					groups: GCP_METRIC_GROUPS.filter(isRegional),
				}),
				resourceVariable({
					name: "workload",
					label: "Workload",
					attributeKey: "service.name",
					groups: GCP_METRIC_GROUPS.filter((group) => WORKLOAD_RESOURCES.has(group.resourceType)),
				}),
			],
			sections: [
				{
					id: SECTION_ID,
					title: "Services",
					collapsible: false,
					tabs: TABS.map((tab) => ({ id: tab.id, title: tab.title })),
				},
			],
			widgets: TABS.flatMap((tab) => tab.charts.map((chart, index) => widget(tab, chart, index))),
		})
	},
}
