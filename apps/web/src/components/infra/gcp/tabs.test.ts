import { describe, expect, it } from "vitest"

import { GCP_INFRA_SERVICE_IDS, GCP_INFRA_SERVICES, gcpInfraMetrics } from "@maple/domain/gcp-infra"
import { GCP_ASSET_TYPES } from "@maple/domain/gcp-metrics"
import {
	GCP_INFRA_COLUMNS,
	GCP_VIEW_SERVICES,
	formatGcpValue,
	gcpAssetTypeLabel,
	gcpHasRegion,
	gcpInfraNotice,
	gcpInfraSetupPending,
	gcpServiceView,
	gcpResourceName,
	gcpResourcesError,
	gcpStateLabel,
	gcpWorkloadKeys,
	gcpWorkloadName,
	gcpWorkloadNoun,
	gcpWorkloadProject,
	gcpWorkloadRegion,
	gcpWorkloadSearch,
	gcpWorkloadTone,
	gcpWorkloads,
	type GcpMetricPoint,
	type GcpMetricReader,
} from "./tabs"

const point = (
	keys: ReadonlyArray<string>,
	metric: string,
	label: string,
	total: number,
	samples = 1,
): GcpMetricPoint => ({ keys, metric, label, total, samples })

const API = ["api", "acme-prod", "europe-west1"]
const WORKER = ["worker", "acme-prod", "europe-west1"]

const valuesOf = (service: (typeof GCP_INFRA_SERVICE_IDS)[number], points: ReadonlyArray<GcpMetricPoint>) =>
	gcpWorkloads(service, points).map((workload) =>
		Object.fromEntries(
			GCP_INFRA_COLUMNS[service].map((spec, index) => [spec.label, workload.values[index]]),
		),
	)

describe("GCP_INFRA_COLUMNS", () => {
	it("reads only metrics the tab's query returns", () => {
		for (const service of GCP_INFRA_SERVICE_IDS) {
			const known = new Set(gcpInfraMetrics(service).map((metric) => metric.name))
			const read: Array<string> = []
			const recorder: GcpMetricReader = {
				total: (metric) => {
					read.push(metric)
					return 0
				},
				mean: (metric) => {
					read.push(metric)
					return undefined
				},
			}
			for (const spec of GCP_INFRA_COLUMNS[service]) spec.value(recorder)
			expect(read.length, service).toBeGreaterThan(0)
			expect(
				read.filter((metric) => !known.has(metric)),
				service,
			).toEqual([])
		}
	})

	it("labels every column uniquely in its service", () => {
		for (const service of GCP_INFRA_SERVICE_IDS) {
			const labels = GCP_INFRA_COLUMNS[service].map((spec) => spec.label)
			expect(new Set(labels).size, service).toBe(labels.length)
		}
	})
})

describe("gcpWorkloads", () => {
	it("folds a service's points into one row per workload", () => {
		const rows = gcpWorkloads("cloudRun", [
			point(API, "gcp.cloud_run.requests", "2xx", 900),
			point(API, "gcp.cloud_run.requests", "5xx", 100),
			// 60 points whose mean is 125 ms.
			point(API, "gcp.cloud_run.request.duration", "0.95", 7.5, 60),
			point(API, "gcp.cloud_run.request.duration", "0.99", 30, 60),
			point(API, "gcp.cloud_run.container.instance.count", "active", 180, 60),
			point(API, "gcp.cloud_run.container.instance.count", "idle", 60, 60),
			point(API, "gcp.cloud_run.container.cpu.utilization", "0.95", 30, 60),
			point(WORKER, "gcp.cloud_run.container.instance.count", "active", 60, 60),
		])
		expect(rows.map((row) => row.keys)).toEqual([API, WORKER])
		expect(rows[0]?.values).toEqual([1000, 0.1, 0.125, 0.5, 3, 0.5, undefined])
		// A workload with no requests still has a row: counters read zero, the rest are absent.
		expect(rows[1]?.values).toEqual([0, undefined, undefined, undefined, 1, undefined, undefined])
	})

	it("counts the load balancer's numeric response class as a server error", () => {
		const lb = ["web-map", "web-backend", "acme-prod"]
		expect(
			valuesOf("loadBalancing", [
				point(lb, "gcp.load_balancing.requests", "200", 75),
				point(lb, "gcp.load_balancing.requests", "500", 25),
			])[0],
		).toMatchObject({ Requests: 100, "5xx rate": 0.25 })
	})

	it("reads failures as everything outside the healthy label value", () => {
		expect(
			valuesOf("cloudFunctions", [
				point(API, "gcp.cloud_functions.executions", "ok", 90),
				point(API, "gcp.cloud_functions.executions", "timeout", 6),
				point(API, "gcp.cloud_functions.executions", "crash", 4),
			])[0],
		).toMatchObject({ Executions: 100, "Error rate": 0.1 })
		// A pull subscription makes no push requests: there is no rate to show.
		expect(
			valuesOf("pubsub", [
				point(["orders", "acme-prod"], "gcp.pubsub.subscription.undelivered_messages", "", 0, 60),
			])[0],
		).toMatchObject({ Backlog: 0, Delivered: 0, "Push errors": undefined })
	})

	it("turns CPU seconds per minute into cores and keeps to non-evictable memory", () => {
		const container = ["api", "default", "prod", "acme-prod", "europe-west1"]
		expect(
			valuesOf("gke", [
				// 30 CPU seconds in each of 10 minutes.
				point(container, "gcp.gke.container.cpu.time", "", 300, 10),
				point(container, "gcp.gke.container.memory.usage", "non-evictable", 5120, 10),
				point(container, "gcp.gke.container.memory.usage", "evictable", 99_999, 10),
			])[0],
		).toMatchObject({ "CPU cores": 0.5, Memory: 512, Restarts: 0, "CPU of limit": undefined })
	})

	it("splits a Compute Engine byte counter by its direction", () => {
		const vm = ["web-1", "acme-prod", "europe-west4-b"]
		expect(
			valuesOf("computeEngine", [
				point(vm, "gcp.gce.network.io", "receive", 2048),
				point(vm, "gcp.gce.network.io", "transmit", 512),
				point(vm, "gcp.gce.disk.io", "write", 4096),
			])[0],
		).toMatchObject({ "Network in": 2048, "Network out": 512, "Disk read": 0, "Disk write": 4096 })
	})
})

describe("workload health", () => {
	const DB = ["acme-prod:main", "acme-prod", "europe-west1"]
	const database = (cpu: number, disk: number) =>
		gcpWorkloads("cloudSql", [
			point(DB, "gcp.cloud_sql.cpu.utilization", "", cpu),
			point(DB, "gcp.cloud_sql.disk.utilization", "", disk),
		])[0]
	const service = (ok: number, failed: number) =>
		gcpWorkloads("cloudRun", [
			point(API, "gcp.cloud_run.requests", "2xx", ok),
			point(API, "gcp.cloud_run.requests", "5xx", failed),
		])[0]

	it("rates saturation by the busiest share of a limit", () => {
		expect(database(0.2, 0.5).saturation).toBe("ok")
		expect(database(0.2, 0.65).saturation).toBe("warn")
		expect(database(0.95, 0.65).saturation).toBe("crit")
		// A latency or a count is no share of anything.
		expect(
			gcpWorkloads("cloudRun", [point(API, "gcp.cloud_run.request.duration", "0.95", 5)])[0],
		).toMatchObject({
			saturation: "ok",
			errors: "neutral",
		})
	})

	it("rates an error rate only over enough events", () => {
		expect(service(990, 10).errors).toBe("warn")
		expect(service(900, 100).errors).toBe("crit")
		expect(service(999, 1).errors).toBe("neutral")
		// One failure of two is shown in the table and raises nothing.
		expect(service(1, 1)).toMatchObject({ values: expect.arrayContaining([0.5]), errors: "neutral" })
	})

	it("tones a workload by the worse of its saturation and error rate", () => {
		expect(gcpWorkloadTone(database(0.95, 0.1))).toBe("crit")
		expect(gcpWorkloadTone(database(0.7, 0.1))).toBe("warn")
		expect(gcpWorkloadTone(service(900, 100))).toBe("crit")
		expect(gcpWorkloadTone(service(1000, 0))).toBe("neutral")
	})
})

describe("workload identity", () => {
	const CONTAINER = ["api", "payments", "prod", "acme-prod", "us-central1-a"]

	it("reads the project, and the region of a regional or a zonal workload", () => {
		expect(gcpWorkloadProject("gke", CONTAINER)).toBe("acme-prod")
		expect(gcpWorkloadRegion("gke", CONTAINER)).toBe("us-central1")
		expect(gcpWorkloadRegion("cloudRun", API)).toBe("europe-west1")
		expect(gcpWorkloadRegion("computeEngine", ["web-1", "acme-prod", "europe-west4-b"])).toBe(
			"europe-west4",
		)
		// A subscription is global.
		expect(gcpWorkloadRegion("pubsub", ["orders", "acme-prod"])).toBeUndefined()
		expect(gcpWorkloadProject("pubsub", ["orders", "acme-prod"])).toBe("acme-prod")
	})

	it("carries every identity value after the name in a page's address, and reads it back", () => {
		expect(gcpWorkloadSearch("gke", CONTAINER)).toEqual({
			namespace: "payments",
			cluster: "prod",
			project: "acme-prod",
			location: "us-central1-a",
		})
		for (const id of GCP_INFRA_SERVICE_IDS) {
			const keys = GCP_INFRA_SERVICES[id].identity.map(([label]) => `a ${label}`)
			expect(gcpWorkloadKeys(id, keys[0], gcpWorkloadSearch(id, keys)), id).toEqual(keys)
		}
	})

	it("names a Cloud SQL instance without the project Cloud Monitoring puts before it", () => {
		expect(gcpWorkloadName("cloudSql", ["acme-prod:main", "acme-prod", "europe-west1"])).toBe("main")
		expect(gcpWorkloadName("cloudRun", API)).toBe("api")
	})

	it("knows which services have a region to filter by", () => {
		expect(GCP_INFRA_SERVICE_IDS.filter((id) => !gcpHasRegion(id))).toEqual(["pubsub", "loadBalancing"])
	})

	it("marks the columns that are totals over the range", () => {
		expect(
			GCP_INFRA_COLUMNS.computeEngine.filter((spec) => spec.total).map((spec) => spec.label),
		).toEqual(["Network in", "Network out", "Disk read", "Disk write"])
	})

	it("names a row in running text, keeping an acronym", () => {
		expect(gcpWorkloadNoun("gke")).toBe("container")
		expect(gcpWorkloadNoun("loadBalancing")).toBe("URL map")
	})

	it("reads an address without its params as empty identity values", () => {
		expect(gcpWorkloadKeys("cloudRun", "api", { project: "acme-prod" })).toEqual(["api", "acme-prod", ""])
	})
})

describe("formatGcpValue", () => {
	it("formats by unit and marks an absent value", () => {
		expect(formatGcpValue("count", 12_345)).toBe("12.3K")
		expect(formatGcpValue("percent", 0.42)).toBe("42%")
		expect(formatGcpValue("errorRate", 0.001)).toBe("0.1%")
		expect(formatGcpValue("seconds", 1.5)).toBe("1.50s")
		expect(formatGcpValue("seconds", 90)).toBe("1.5min")
		expect(formatGcpValue("bytes", 1536)).toBe("1.5 KB")
		expect(formatGcpValue("bytes", undefined)).toBe("—")
	})

	it("writes CPU below one core in millicores", () => {
		expect(formatGcpValue("cores", 0.012)).toBe("12m")
		expect(formatGcpValue("cores", 0.0002)).toBe("<1m")
		expect(formatGcpValue("cores", 0)).toBe("0m")
		expect(formatGcpValue("cores", 1.25)).toBe("1.25")
	})
})

describe("gcpServiceView", () => {
	it("lists every service in exactly the view it names", () => {
		for (const service of GCP_INFRA_SERVICE_IDS) {
			const views = Object.entries(GCP_VIEW_SERVICES).filter(([, services]) =>
				services.some((listed) => listed === service),
			)
			expect(
				views.map(([view]) => view),
				service,
			).toEqual([gcpServiceView(service)])
		}
	})
})

describe("gcpInfraNotice", () => {
	const NOW = Date.parse("2026-10-08T12:00:00.000Z")
	const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
	const connector = (over: Partial<Parameters<typeof gcpInfraNotice>[0][number]> = {}) => ({
		scope_type: "project" as const,
		metrics_enabled: true,
		applied_metrics_enabled: true as boolean | null,
		setup_reported_at: ago(60) as string | null,
		last_metrics_received_at: ago(4) as string | null,
		last_metrics_error: null as string | null,
		discovered_project_count: 1,
		last_resources_error: null,
		created_at: ago(120),
		...over,
	})
	const unset = connector({
		applied_metrics_enabled: null,
		setup_reported_at: null,
		last_metrics_received_at: null,
	})
	const waiting = connector({ last_metrics_received_at: null, setup_reported_at: ago(1) })

	it("says nothing while metrics arrive for the window", () => {
		expect(gcpInfraNotice([connector()], true, NOW)).toBeNull()
	})

	it("is setup pending only while no connection has run its script", () => {
		expect(gcpInfraSetupPending([unset], NOW)).toBe(true)
		expect(gcpInfraSetupPending([unset, waiting], NOW)).toBe(false)
	})

	it("waits for the first read once the script reported", () => {
		expect(gcpInfraNotice([unset, waiting], false, NOW)).toEqual({ kind: "waiting" })
	})

	it("waits while a run that reported on logs is still working on metrics", () => {
		const running = connector({
			applied_metrics_enabled: null,
			setup_reported_at: ago(1),
			last_metrics_received_at: null,
		})
		expect(gcpInfraSetupPending([running], NOW)).toBe(false)
		expect(gcpInfraNotice([running], false, NOW)).toEqual({ kind: "waiting" })
	})

	it("says metrics are switched off when no connection collects them", () => {
		expect(gcpInfraNotice([], true, NOW)).toEqual({ kind: "off" })
	})

	it("tells a quiet window from a connector that never read", () => {
		expect(gcpInfraNotice([waiting, connector()], false, NOW)).toEqual({ kind: "quiet" })
	})

	it("reports the worst connection even while other metrics arrive", () => {
		const incomplete = connector({ last_metrics_error: "2 of 46 metric queries failed." })
		const failing = connector({ last_metrics_received_at: ago(42), last_metrics_error: "denied" })
		expect(gcpInfraNotice([connector(), incomplete], true, NOW)).toEqual({
			kind: "incomplete",
			error: "2 of 46 metric queries failed.",
		})
		expect(gcpInfraNotice([incomplete, failing], true, NOW)).toEqual({
			kind: "failing",
			error: "denied",
		})
		expect(gcpInfraNotice([connector({ last_metrics_received_at: ago(42) })], true, NOW)).toEqual({
			kind: "stalled",
		})
	})
})

describe("resources", () => {
	it("names every collected asset type", () => {
		for (const assetType of GCP_ASSET_TYPES) {
			expect(gcpAssetTypeLabel(assetType), assetType).not.toBe(assetType)
		}
		expect(gcpAssetTypeLabel("storage.googleapis.com/Bucket")).toBe("storage.googleapis.com/Bucket")
	})

	it("names a resource by its display name, else by the end of its full name", () => {
		const name = "//run.googleapis.com/projects/acme-prod/locations/europe-west1/services/api"
		expect(gcpResourceName({ name, displayName: "Public API" })).toBe("Public API")
		expect(gcpResourceName({ name, displayName: null })).toBe("api")
		expect(gcpResourceName({ name, displayName: "" })).toBe("api")
	})

	it("writes a state in sentence case", () => {
		expect(gcpStateLabel("RUNNING")).toBe("Running")
		expect(gcpStateLabel("PENDING_CREATE")).toBe("Pending create")
	})

	it("surfaces the first failing inventory sync", () => {
		expect(gcpResourcesError([{ last_resources_error: null }])).toBeNull()
		expect(
			gcpResourcesError([{ last_resources_error: null }, { last_resources_error: "incomplete" }]),
		).toBe("incomplete")
	})
})
