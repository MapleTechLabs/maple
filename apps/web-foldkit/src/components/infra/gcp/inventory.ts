// How a workload of the metric tables and a resource of the inventory find each other, and where
// a workload links to. A match is by identity only: asset type, project, name and, where the
// workload has one, location. Pure.

import {
	GCP_INFRA_SERVICES,
	GCP_INFRA_SOURCES,
	gcpInfraNamesService,
	gcpInfraServiceName,
	type GcpInfraServiceId,
	type GcpInfraSourceId,
} from "@maple/domain/gcp-infra"
import type { GcpCloudSqlSettings, GcpResource } from "@maple/domain/http"

import { appendWhereFilter } from "../../metrics/where-filter"
import { encodeLogAttributeFilter } from "../../../lib/logs/log-attribute-filters"

import { gcpWorkloadLocation, gcpWorkloadProject } from "./tabs"

const RUN_SERVICE = "run.googleapis.com/Service"
const FUNCTION = "cloudfunctions.googleapis.com/CloudFunction"
const CLUSTER = "container.googleapis.com/Cluster"
const INSTANCE = "compute.googleapis.com/Instance"
const SQL_INSTANCE = "sqladmin.googleapis.com/Instance"
const SUBSCRIPTION = "pubsub.googleapis.com/Subscription"
const URL_MAP = "compute.googleapis.com/UrlMap"

/** The inventory type behind a service's workloads, and the identity value that names the resource. */
const RESOURCE_OF: Record<
	GcpInfraServiceId,
	{ readonly assetType: string; readonly name: (keys: ReadonlyArray<string>) => string }
> = {
	cloudRun: { assetType: RUN_SERVICE, name: (keys) => keys[0] },
	cloudFunctions: { assetType: FUNCTION, name: (keys) => keys[0] },
	// A container has no inventory entry of its own: its cluster has.
	gke: { assetType: CLUSTER, name: (keys) => keys[2] },
	computeEngine: { assetType: INSTANCE, name: (keys) => keys[0] },
	// Cloud Monitoring names an instance `<project>:<instance>`.
	cloudSql: { assetType: SQL_INSTANCE, name: (keys) => keys[0].slice(keys[0].indexOf(":") + 1) },
	pubsub: { assetType: SUBSCRIPTION, name: (keys) => keys[0] },
	loadBalancing: { assetType: URL_MAP, name: (keys) => keys[0] },
} satisfies Record<
	GcpInfraServiceId,
	{ readonly assetType: string; readonly name: (keys: ReadonlyArray<string>) => string }
>

const lastSegment = (name: string) => name.slice(name.lastIndexOf("/") + 1)

/** A Cloud SQL instance's settings from the inventory, by the `<project>:<instance>` the metrics name it. */
export interface GcpCloudSqlInstance extends GcpCloudSqlSettings {
	readonly id: string
	/** The instance's name within its project. */
	readonly name: string
}

/** The inventory read that lists every Cloud SQL instance with its settings. */
export const GCP_CLOUD_SQL_INVENTORY_QUERY = { assetType: SQL_INSTANCE }

/** The Cloud SQL instances whose settings the inventory has synced. */
export const gcpCloudSqlInstances = (
	resources: ReadonlyArray<GcpResource>,
): ReadonlyArray<GcpCloudSqlInstance> =>
	resources.flatMap((resource) =>
		resource.assetType !== SQL_INSTANCE || resource.details === null
			? []
			: [
					{
						...resource.details,
						id: `${resource.projectId}:${lastSegment(resource.name)}`,
						name: lastSegment(resource.name),
					},
				],
	)

/** The inventory read that finds a workload's resource: see `gcpMatchResource`. */
export const gcpResourceQuery = (service: GcpInfraServiceId, keys: ReadonlyArray<string>) => ({
	assetType: RESOURCE_OF[service].assetType,
	projectId: gcpWorkloadProject(service, keys) || undefined,
	name: RESOURCE_OF[service].name(keys) || undefined,
})

/**
 * The one inventory resource a workload is, or undefined: none listed, or more than one that the
 * workload's identity cannot tell apart.
 */
export function gcpMatchResource(
	service: GcpInfraServiceId,
	keys: ReadonlyArray<string>,
	resources: ReadonlyArray<GcpResource>,
): GcpResource | undefined {
	const { assetType, projectId, name } = gcpResourceQuery(service, keys)
	const location = gcpWorkloadLocation(service, keys)
	const matches = resources.filter(
		(resource) =>
			resource.assetType === assetType &&
			resource.projectId === projectId &&
			lastSegment(resource.name) === name &&
			(location === undefined || resource.location === location),
	)
	return matches.length === 1 ? matches[0] : undefined
}

/** The workload page of an inventory resource, for the types that are one workload. */
export function gcpResourceWorkload(
	resource: GcpResource,
): { readonly service: GcpInfraServiceId; readonly keys: ReadonlyArray<string> } | undefined {
	const name = lastSegment(resource.name)
	const { projectId, location } = resource
	if (resource.assetType === SUBSCRIPTION) return { service: "pubsub", keys: [name, projectId] }
	if (location === null) return undefined
	switch (resource.assetType) {
		case RUN_SERVICE:
			return { service: "cloudRun", keys: [name, projectId, location] }
		case FUNCTION:
			return { service: "cloudFunctions", keys: [name, projectId, location] }
		case INSTANCE:
			return { service: "computeEngine", keys: [name, projectId, location] }
		case SQL_INSTANCE:
			return { service: "cloudSql", keys: [`${projectId}:${name}`, projectId, location] }
		default:
			return undefined
	}
}

const consoleUrl = (path: string, query: string, id: string) =>
	`https://console.cloud.google.com/${path}?${query}=${encodeURIComponent(id)}`

/** A workload's console pages: its own, and its log entries in the Logs Explorer. */
export interface GcpConsoleLinks {
	readonly page: { readonly label: string; readonly href: string }
	readonly logs: string
}

const resourceFilter = (resourceType: string, labels: ReadonlyArray<readonly [string, string]>) =>
	[`resource.type="${resourceType}"`, ...labels.map(([label, value]) => `${label}="${value}"`)].join("\n")

/**
 * A workload's console pages, from its identity alone: Cloud Run, Cloud Functions, Compute Engine,
 * Cloud SQL and Pub/Sub open the resource's own page, a GKE container its cluster's, and a load
 * balancer the list, whose detail address depends on the load balancer's kind.
 */
export function gcpConsoleLinks(service: GcpInfraServiceId, keys: ReadonlyArray<string>): GcpConsoleLinks {
	const project = gcpWorkloadProject(service, keys) ?? ""
	const at = (path: string) => consoleUrl(path, "project", project)
	const segment = encodeURIComponent
	const [name = ""] = keys
	const logs = (filter: string) => at(`logs/query;query=${segment(filter)}`)
	switch (service) {
		case "cloudRun": {
			const region = keys[2] ?? ""
			return {
				page: {
					label: "Cloud Run service",
					href: at(`run/detail/${segment(region)}/${segment(name)}/metrics`),
				},
				logs: logs(
					resourceFilter("cloud_run_revision", [
						["resource.labels.service_name", name],
						["resource.labels.location", region],
					]),
				),
			}
		}
		case "cloudFunctions": {
			const region = keys[2] ?? ""
			return {
				page: {
					label: "Cloud Function",
					href: at(`functions/details/${segment(region)}/${segment(name)}`),
				},
				logs: logs(
					resourceFilter("cloud_function", [
						["resource.labels.function_name", name],
						["resource.labels.region", region],
					]),
				),
			}
		}
		case "gke": {
			const [, namespace = "", cluster = "", , location = ""] = keys
			return {
				page: {
					label: `Cluster ${cluster}`,
					href: at(`kubernetes/clusters/details/${segment(location)}/${segment(cluster)}/details`),
				},
				logs: logs(
					resourceFilter("k8s_container", [
						["resource.labels.cluster_name", cluster],
						["resource.labels.namespace_name", namespace],
						["resource.labels.container_name", name],
					]),
				),
			}
		}
		case "computeEngine": {
			const zone = keys[2] ?? ""
			return {
				page: {
					label: "VM instance",
					href: at(`compute/instancesDetail/zones/${segment(zone)}/instances/${segment(name)}`),
				},
				logs: logs(
					resourceFilter("gce_instance", [['labels."compute.googleapis.com/resource_name"', name]]),
				),
			}
		}
		case "cloudSql": {
			// The instance's id is `project:instance`.
			const instance = name.slice(name.indexOf(":") + 1)
			return {
				page: {
					label: "Cloud SQL instance",
					href: at(`sql/instances/${segment(instance)}/overview`),
				},
				logs: logs(resourceFilter("cloudsql_database", [["resource.labels.database_id", name]])),
			}
		}
		case "pubsub":
			return {
				page: {
					label: "Pub/Sub subscription",
					href: at(`cloudpubsub/subscription/detail/${segment(name)}`),
				},
				logs: logs(
					resourceFilter("pubsub_subscription", [["resource.labels.subscription_id", name]]),
				),
			}
		case "loadBalancing":
			return {
				page: { label: "Load balancers", href: at("net-services/loadbalancing/list/loadBalancers") },
				logs: logs(resourceFilter("http_load_balancer", [["resource.labels.url_map_name", name]])),
			}
	}
}

/** The console page of what a connection covers: the project's dashboard, or the folder or organization in the resource manager. */
export function gcpConsoleScopePage(scope: {
	readonly scope_type: string
	readonly scope_id: string
}): string {
	switch (scope.scope_type) {
		case "organization":
			return consoleUrl("cloud-resource-manager", "organizationId", scope.scope_id)
		case "folder":
			return consoleUrl("cloud-resource-manager", "folder", scope.scope_id)
		default:
			return consoleUrl("home/dashboard", "project", scope.scope_id)
	}
}

/** A project's console pages for what Maple shows of it: its metrics, logs and resources. */
export const gcpConsoleProjectPages = (
	project: string,
): ReadonlyArray<{ readonly label: string; readonly href: string }> =>
	[
		["Dashboard", "home/dashboard"],
		["Metrics Explorer", "monitoring/metrics-explorer"],
		["Logs Explorer", "logs/query"],
		["Asset Inventory", "iam-admin/asset-inventory/dashboard"],
	].map(([label, path]) => ({ label, href: consoleUrl(path, "project", project) }))

/**
 * Where a workload's other telemetry is. Its metrics, and its traces when it is instrumented, are
 * under `serviceName`: the workload's own for compute, `gcp/<resource type>` for a managed
 * service. Its logs are under the same name, narrowed for a managed service by the identifying
 * resource attribute.
 */
export function gcpWorkloadTelemetry(
	service: GcpInfraServiceId,
	keys: ReadonlyArray<string>,
): {
	readonly serviceName: string
	readonly traced: boolean
	readonly logsService: string
	readonly logAttrs: ReadonlyArray<string>
} {
	const serviceName = gcpInfraServiceName(service, keys)
	if (gcpInfraNamesService(service)) {
		return { serviceName, traced: true, logsService: serviceName, logAttrs: [] }
	}
	return {
		serviceName,
		traced: false,
		// Cloud Logging writes a load balancer's logs under another resource type than Cloud
		// Monitoring writes its metrics, with the same `url_map_name` label.
		logsService: service === "loadBalancing" ? "gcp/http_load_balancer" : serviceName,
		logAttrs: [
			encodeLogAttributeFilter({
				source: "resource",
				key: GCP_INFRA_SERVICES[service].identity[0][1],
				// Cloud Logging labels a subscription with its full path, Cloud Monitoring with its id.
				value:
					service === "pubsub"
						? `projects/${gcpWorkloadProject(service, keys)}/subscriptions/${keys[0]}`
						: keys[0],
				negated: false,
			}),
		],
	}
}

/**
 * The metrics explorer filter for one workload's series: its service name where that is the
 * workload's own, else the resource attribute that names it under `gcp/<resource type>`.
 */
export const gcpExplorerWhere = (source: GcpInfraSourceId, keys: ReadonlyArray<string>): string =>
	gcpInfraNamesService(source)
		? appendWhereFilter("", "service.name", keys[0])
		: appendWhereFilter("", `resource.${GCP_INFRA_SOURCES[source].identity[0][1]}`, keys[0])
