// How a workload of the metric tables and a resource of the inventory find each other, and where
// a workload links to. A match is by identity only: asset type, project, name and, where the
// workload has one, location. Pure (no React, no atoms).

import {
	GCP_INFRA_SERVICES,
	gcpInfraNamesService,
	gcpInfraServiceName,
	type GcpInfraServiceId,
} from "@maple/domain/gcp-infra"
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

/**
 * The Google Cloud console page that lists a resource type, as Google's documentation links it.
 * The console's per-resource addresses are not documented, so none is built.
 */
const CONSOLE_PAGES: Record<string, readonly [label: string, path: string]> = {
	[RUN_SERVICE]: ["Cloud Run services", "run/services"],
	// The 1st gen documentation sends a function's owner to the Cloud Run page too.
	[FUNCTION]: ["Cloud Run services", "run/services"],
	[CLUSTER]: ["Kubernetes clusters", "kubernetes/list"],
	[INSTANCE]: ["VM instances", "compute/instances"],
	[SQL_INSTANCE]: ["Cloud SQL instances", "sql"],
	[SUBSCRIPTION]: ["Pub/Sub subscriptions", "cloudpubsub/subscription"],
	[URL_MAP]: ["Load balancing", "net-services/loadbalancing/list"],
} satisfies Record<string, readonly [label: string, path: string]>

/** The console page that lists a resource's type, opened on the resource's project. */
export function gcpConsolePage(
	resource: GcpResource,
): { readonly label: string; readonly href: string } | undefined {
	const page = CONSOLE_PAGES[resource.assetType]
	if (page === undefined) return undefined
	const [label, path] = page
	return {
		label,
		href: `https://console.cloud.google.com/${path}?project=${encodeURIComponent(resource.projectId)}`,
	}
}

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
				value: keys[0],
				negated: false,
			}),
		],
	}
}
