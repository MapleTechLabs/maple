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

/** The curated metrics behind a tab. */
export const gcpInfraMetrics = (service: GcpInfraServiceId): ReadonlyArray<GcpMetric> =>
	GCP_METRIC_GROUPS.find((group) => group.resourceType === GCP_INFRA_SERVICES[service].resourceType)
		?.metrics ?? []

/** Cap on the rows of one tab's query: one row per workload, metric and label value. */
export const GCP_INFRA_ROW_LIMIT = 10_000
