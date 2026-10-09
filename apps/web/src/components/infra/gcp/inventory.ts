// How a workload of the metric tables and a resource of the inventory find each other, and where
// a workload links to. A match is by identity only: asset type, project, name and, where the
// workload has one, location. Pure (no React, no atoms).

import { GCP_INFRA_SERVICES, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { GcpResource } from "@maple/domain/http"

import { encodeLogAttributeFilter } from "@/lib/logs/log-attribute-filters"

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

const CONSOLE = "https://console.cloud.google.com"

/** The resource's page in the Google Cloud console, for the types whose address Maple can build. */
export function gcpConsoleUrl(resource: GcpResource): string | undefined {
	const name = encodeURIComponent(lastSegment(resource.name))
	const location = encodeURIComponent(resource.location ?? "")
	const project = `project=${encodeURIComponent(resource.projectId)}`
	switch (resource.assetType) {
		case RUN_SERVICE:
			return `${CONSOLE}/run/detail/${location}/${name}/metrics?${project}`
		case FUNCTION:
			return `${CONSOLE}/functions/details/${location}/${name}?${project}`
		case CLUSTER:
			return `${CONSOLE}/kubernetes/clusters/details/${location}/${name}/details?${project}`
		case INSTANCE:
			return `${CONSOLE}/compute/instancesDetail/zones/${location}/instances/${name}?${project}`
		case SQL_INSTANCE:
			return `${CONSOLE}/sql/instances/${name}/overview?${project}`
		case SUBSCRIPTION:
			return `${CONSOLE}/cloudpubsub/subscription/detail/${name}?${project}`
		default:
			return undefined
	}
}

/**
 * The service name a workload's logs and traces carry: the workload's own for compute, and
 * `gcp/<resource type>` for a managed service, whose logs the identifying attribute narrows.
 */
export function gcpWorkloadTelemetry(
	service: GcpInfraServiceId,
	keys: ReadonlyArray<string>,
): { readonly serviceName: string; readonly traced: boolean; readonly logAttrs: ReadonlyArray<string> } {
	const { resourceType, identity } = GCP_INFRA_SERVICES[service]
	if (identity[0][1].startsWith("gcp.resource.labels.")) {
		return {
			// Cloud Logging writes a load balancer's logs under another resource type than
			// Cloud Monitoring writes its metrics, with the same `url_map_name` label.
			serviceName: `gcp/${service === "loadBalancing" ? "http_load_balancer" : resourceType}`,
			traced: false,
			logAttrs: [
				encodeLogAttributeFilter({
					source: "resource",
					key: identity[0][1],
					value: keys[0],
					negated: false,
				}),
			],
		}
	}
	return { serviceName: keys[0], traced: true, logAttrs: [] }
}
