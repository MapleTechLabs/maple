/**
 * The Infrastructure -> Google Cloud page: one tab per curated service, a table with one row per
 * workload. A tab reads one group of `GCP_METRIC_GROUPS`, and a row is identified by resource
 * attributes the metrics poller stores.
 */
import { GCP_METRIC_GROUPS, type GcpMetric } from "./gcp-metrics"

export const GCP_INFRA_SERVICE_IDS = [
	"cloudRun",
	"cloudFunctions",
	"gke",
	"computeEngine",
	"cloudSql",
	"pubsub",
	"loadBalancing",
] as const
export type GcpInfraServiceId = (typeof GCP_INFRA_SERVICE_IDS)[number]

export interface GcpInfraService {
	readonly title: string
	/** The metric group the tab reads. */
	readonly resourceType: string
	/** What identifies a row, as column label and resource attribute. The first names the row. */
	readonly identity: ReadonlyArray<readonly [label: string, attribute: string]>
}

const PROJECT = ["Project", "cloud.account.id"] as const
const REGION = ["Region", "cloud.region"] as const
const resourceLabel = (name: string) => `gcp.resource.labels.${name}`

export const GCP_INFRA_SERVICES: Record<GcpInfraServiceId, GcpInfraService> = {
	// Includes Cloud Functions (2nd gen), which run on Cloud Run.
	cloudRun: {
		title: "Cloud Run",
		resourceType: "cloud_run_revision",
		identity: [["Service", "service.name"], PROJECT, REGION],
	},
	// 1st gen.
	cloudFunctions: {
		title: "Cloud Functions",
		resourceType: "cloud_function",
		identity: [["Function", "service.name"], PROJECT, REGION],
	},
	// One row per container name: Cloud Monitoring has already folded the pods together.
	gke: {
		title: "GKE",
		resourceType: "k8s_container",
		identity: [
			["Container", "k8s.container.name"],
			["Namespace", "k8s.namespace.name"],
			["Cluster", "k8s.cluster.name"],
			PROJECT,
			["Location", resourceLabel("location")],
		],
	},
	computeEngine: {
		title: "Compute Engine",
		resourceType: "gce_instance",
		identity: [["Instance", "host.name"], PROJECT, ["Zone", "cloud.availability_zone"]],
	},
	cloudSql: {
		title: "Cloud SQL",
		resourceType: "cloudsql_database",
		identity: [["Instance", resourceLabel("database_id")], PROJECT, REGION],
	},
	pubsub: {
		title: "Pub/Sub",
		resourceType: "pubsub_subscription",
		identity: [["Subscription", resourceLabel("subscription_id")], PROJECT],
	},
	loadBalancing: {
		title: "Load Balancing",
		resourceType: "https_lb_rule",
		identity: [
			["URL map", resourceLabel("url_map_name")],
			["Backend", resourceLabel("backend_target_name")],
			PROJECT,
		],
	},
} satisfies Record<GcpInfraServiceId, GcpInfraService>

/**
 * What a chart can read: a tab's workloads, or the nodes of a GKE cluster, which have no tab and
 * chart on the page of a container that runs on them.
 */
export const GCP_INFRA_SOURCE_IDS = [...GCP_INFRA_SERVICE_IDS, "gkeNodes"] as const
export type GcpInfraSourceId = (typeof GCP_INFRA_SOURCE_IDS)[number]

export const GCP_INFRA_SOURCES: Record<GcpInfraSourceId, GcpInfraService> = {
	...GCP_INFRA_SERVICES,
	gkeNodes: {
		title: "GKE nodes",
		resourceType: "k8s_node",
		identity: [["Cluster", "k8s.cluster.name"], PROJECT, ["Location", resourceLabel("location")]],
	},
} satisfies Record<GcpInfraSourceId, GcpInfraService>

/** Identity attributes that name a compute workload, which is also its `service.name`. */
const WORKLOAD_NAME_ATTRIBUTES = ["service.name", "k8s.container.name", "host.name"]

/** Whether a source's rows are named after the workload; the rest are `gcp/<resource type>`. */
export const gcpInfraNamesService = (source: GcpInfraSourceId): boolean =>
	WORKLOAD_NAME_ATTRIBUTES.includes(GCP_INFRA_SOURCES[source].identity[0][1])

/** The `service.name` the series of one workload carry: see `gcpResourceAttributes`. */
export const gcpInfraServiceName = (source: GcpInfraSourceId, keys: ReadonlyArray<string>): string =>
	gcpInfraNamesService(source) ? (keys[0] ?? "") : `gcp/${GCP_INFRA_SOURCES[source].resourceType}`

/** The curated metrics behind a tab or a chart source. */
export const gcpInfraMetrics = (source: GcpInfraSourceId): ReadonlyArray<GcpMetric> =>
	GCP_METRIC_GROUPS.find((group) => group.resourceType === GCP_INFRA_SOURCES[source].resourceType)
		?.metrics ?? []

/** Cap on the rows of one query: one row per workload or time bucket, metric and label value. */
export const GCP_INFRA_ROW_LIMIT = 10_000
