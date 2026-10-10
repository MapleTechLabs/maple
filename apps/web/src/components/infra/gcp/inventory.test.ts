import { describe, expect, it } from "vitest"

import { GCP_INFRA_SERVICE_IDS } from "@maple/domain/gcp-infra"
import type { GcpResource } from "@maple/domain/http"
import {
	gcpConsolePage,
	gcpExplorerWhere,
	gcpMatchResource,
	gcpResourceQuery,
	gcpResourceWorkload,
	gcpWorkloadTelemetry,
} from "./inventory"

const resource = (
	assetType: string,
	name: string,
	location: string | null = "europe-west1",
): GcpResource => ({
	name,
	assetType,
	projectId: "acme-prod",
	location,
	displayName: null,
	state: "ACTIVE",
	labels: {},
})

const RUN = "run.googleapis.com/Service"
const api = resource(RUN, "//run.googleapis.com/projects/acme-prod/locations/europe-west1/services/api")
const apiUs = resource(
	RUN,
	"//run.googleapis.com/projects/acme-prod/locations/us-central1/services/api",
	"us-central1",
)
const API = ["api", "acme-prod", "europe-west1"]

describe("gcpResourceQuery", () => {
	it("asks for the workload's asset type, project and resource name", () => {
		expect(gcpResourceQuery("cloudRun", API)).toEqual({
			assetType: RUN,
			projectId: "acme-prod",
			name: "api",
		})
		// Cloud Monitoring prefixes a Cloud SQL instance with its project.
		expect(gcpResourceQuery("cloudSql", ["acme-prod:main", "acme-prod", "europe-west1"]).name).toBe(
			"main",
		)
		// A container's resource is its cluster.
		expect(gcpResourceQuery("gke", ["api", "payments", "prod", "acme-prod", "us-central1"])).toEqual({
			assetType: "container.googleapis.com/Cluster",
			projectId: "acme-prod",
			name: "prod",
		})
	})

	it("leaves out what a short address does not carry", () => {
		expect(gcpResourceQuery("cloudRun", ["api", "", ""])).toEqual({
			assetType: RUN,
			projectId: undefined,
			name: "api",
		})
	})
})

describe("gcpMatchResource", () => {
	it("matches by type, project, name and location", () => {
		expect(gcpMatchResource("cloudRun", API, [apiUs, api])).toBe(api)
	})

	it("matches nothing rather than guess between two candidates", () => {
		// A Pub/Sub subscription has no location to tell them apart.
		const subscription = (name: string) => resource("pubsub.googleapis.com/Subscription", name, null)
		const twins = [
			subscription("//pubsub.googleapis.com/projects/acme-prod/subscriptions/orders"),
			subscription("//pubsub.googleapis.com/projects/acme-prod/subscriptions/v2/orders"),
		]
		expect(gcpMatchResource("pubsub", ["orders", "acme-prod"], twins)).toBeUndefined()
		expect(gcpMatchResource("pubsub", ["orders", "acme-prod"], twins.slice(0, 1))).toBe(twins[0])
	})

	it("matches nothing in another project, location or type, or under another name", () => {
		expect(gcpMatchResource("cloudRun", ["api", "acme-dev", "europe-west1"], [api])).toBeUndefined()
		expect(gcpMatchResource("cloudRun", ["api", "acme-prod", "asia-east1"], [api, apiUs])).toBeUndefined()
		expect(gcpMatchResource("cloudFunctions", API, [api])).toBeUndefined()
		expect(gcpMatchResource("cloudRun", ["ap", "acme-prod", "europe-west1"], [api])).toBeUndefined()
		expect(gcpMatchResource("cloudRun", API, [])).toBeUndefined()
	})
})

describe("gcpResourceWorkload", () => {
	it("opens the page of a resource that is one workload, and round-trips through the match", () => {
		const instance = resource(
			"sqladmin.googleapis.com/Instance",
			"//cloudsql.googleapis.com/projects/acme-prod/instances/main",
		)
		const vm = resource(
			"compute.googleapis.com/Instance",
			"//compute.googleapis.com/projects/acme-prod/zones/europe-west1-b/instances/web-1",
			"europe-west1-b",
		)
		for (const entry of [api, instance, vm]) {
			const workload = gcpResourceWorkload(entry)
			expect(workload, entry.name).toBeDefined()
			if (workload) expect(gcpMatchResource(workload.service, workload.keys, [entry])).toBe(entry)
		}
		expect(gcpResourceWorkload(instance)).toEqual({
			service: "cloudSql",
			keys: ["acme-prod:main", "acme-prod", "europe-west1"],
		})
	})

	it("has no page for a resource that is not one workload", () => {
		for (const assetType of [
			"cloudresourcemanager.googleapis.com/Project",
			"container.googleapis.com/Cluster",
			"compute.googleapis.com/UrlMap",
			"pubsub.googleapis.com/Topic",
			// A 2nd gen function runs as a Cloud Run service under a name Google derives.
			"cloudfunctions.googleapis.com/Function",
		]) {
			expect(
				gcpResourceWorkload(resource(assetType, "//x/projects/acme-prod/y/z")),
				assetType,
			).toBeUndefined()
		}
		// Without a location the workload's region is unknown.
		expect(gcpResourceWorkload({ ...api, location: null })).toBeUndefined()
	})
})

describe("gcpConsolePage", () => {
	it("opens the documented list page of the resource's type on its project", () => {
		expect(gcpConsolePage(api)).toEqual({
			label: "Cloud Run services",
			href: "https://console.cloud.google.com/run/services?project=acme-prod",
		})
		expect(
			gcpConsolePage({
				...resource("compute.googleapis.com/UrlMap", "//compute.googleapis.com/x/y"),
				projectId: "acme prod",
			})?.href,
		).toBe("https://console.cloud.google.com/net-services/loadbalancing/list?project=acme%20prod")
	})

	it("has a page for the resource of every service's workloads, and none for other types", () => {
		for (const service of GCP_INFRA_SERVICE_IDS) {
			const { assetType } = gcpResourceQuery(service, ["a", "b", "c", "d", "e"])
			expect(gcpConsolePage(resource(assetType, "//x/y")), service).toBeDefined()
		}
		expect(gcpConsolePage(resource("pubsub.googleapis.com/Topic", "//x/y"))).toBeUndefined()
	})
})

describe("gcpExplorerWhere", () => {
	it("selects a compute workload by its service name and a managed one by its resource attribute", () => {
		expect(gcpExplorerWhere("cloudRun", API)).toBe('service.name = "api"')
		expect(gcpExplorerWhere("loadBalancing", ["web", "backend", "acme-prod"])).toBe(
			'resource.gcp.resource.labels.url_map_name = "web"',
		)
		expect(gcpExplorerWhere("gkeNodes", ["prod", "acme-prod", "us-central1"])).toBe(
			'resource.k8s.cluster.name = "prod"',
		)
	})
})

describe("gcpWorkloadTelemetry", () => {
	it("names a compute workload's metrics, logs and traces after the workload", () => {
		expect(gcpWorkloadTelemetry("cloudRun", API)).toEqual({
			serviceName: "api",
			traced: true,
			logsService: "api",
			logAttrs: [],
		})
		expect(
			gcpWorkloadTelemetry("gke", ["api", "payments", "prod", "acme-prod", "us-central1"]).serviceName,
		).toBe("api")
		expect(gcpWorkloadTelemetry("computeEngine", ["web-1", "acme-prod", "europe-west1-b"]).traced).toBe(
			true,
		)
	})

	it("narrows a managed service's logs to the resource, with no traces", () => {
		expect(gcpWorkloadTelemetry("cloudSql", ["acme-prod:main", "acme-prod", "europe-west1"])).toEqual({
			serviceName: "gcp/cloudsql_database",
			traced: false,
			logsService: "gcp/cloudsql_database",
			logAttrs: ["res:gcp.resource.labels.database_id=acme-prod:main"],
		})
	})

	it("narrows a subscription's logs by its full path, which is how Cloud Logging labels it", () => {
		expect(gcpWorkloadTelemetry("pubsub", ["orders", "acme-prod"]).logAttrs).toEqual([
			"res:gcp.resource.labels.subscription_id=projects/acme-prod/subscriptions/orders",
		])
	})

	it("reads a load balancer's logs under the type Cloud Logging writes, its metrics under their own", () => {
		expect(gcpWorkloadTelemetry("loadBalancing", ["web", "backend", "acme-prod"])).toEqual({
			serviceName: "gcp/https_lb_rule",
			traced: false,
			logsService: "gcp/http_load_balancer",
			logAttrs: ["res:gcp.resource.labels.url_map_name=web"],
		})
	})

	it("covers every service", () => {
		for (const service of GCP_INFRA_SERVICE_IDS) {
			const telemetry = gcpWorkloadTelemetry(service, ["name", "a", "b", "c", "d"])
			expect(telemetry.serviceName, service).not.toBe("")
			expect(telemetry.logsService, service).not.toBe("")
		}
	})
})
