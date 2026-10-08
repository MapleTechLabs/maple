import { describe, expect, it } from "vitest"

import { GCP_INFRA_SERVICE_IDS, gcpInfraMetrics } from "@maple/domain/gcp-infra"
import { GCP_ASSET_TYPES } from "@maple/domain/gcp-metrics"
import {
	GCP_INFRA_COLUMNS,
	GCP_NAME_SORT,
	formatGcpValue,
	gcpAssetTypeLabel,
	gcpInfraNotice,
	gcpInfraTabs,
	gcpResourceName,
	gcpResourcesError,
	gcpWorkloads,
	sortGcpWorkloads,
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
		Object.fromEntries(GCP_INFRA_COLUMNS[service].map((spec, index) => [spec.label, workload.values[index]])),
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

	it("labels every column uniquely in its tab, apart from the name sort key", () => {
		for (const service of GCP_INFRA_SERVICE_IDS) {
			const labels = GCP_INFRA_COLUMNS[service].map((spec) => spec.label)
			expect(new Set([...labels, GCP_NAME_SORT]).size, service).toBe(labels.length + 1)
		}
	})
})

describe("gcpWorkloads", () => {
	it("folds a service's points into one row per workload", () => {
		const rows = gcpWorkloads("cloudRun", [
			point(API, "gcp.run.request_count", "2xx", 900),
			point(API, "gcp.run.request_count", "5xx", 100),
			// 60 points whose mean is 120 ms.
			point(API, "gcp.run.request_latencies", "0.95", 7200, 60),
			point(API, "gcp.run.request_latencies", "0.99", 30_000, 60),
			point(API, "gcp.run.container.instance_count", "active", 180, 60),
			point(API, "gcp.run.container.instance_count", "idle", 60, 60),
			point(API, "gcp.run.container.cpu.utilizations", "0.95", 30, 60),
			point(WORKER, "gcp.run.container.instance_count", "active", 60, 60),
		])
		expect(rows.map((row) => row.keys)).toEqual([API, WORKER])
		expect(rows[0]?.values).toEqual([1000, 0.1, 120, 500, 3, 0.5, undefined])
		// A workload with no requests still has a row: counters read zero, the rest are absent.
		expect(rows[1]?.values).toEqual([0, undefined, undefined, undefined, 1, undefined, undefined])
	})

	it("counts the load balancer's numeric response class as a server error", () => {
		const lb = ["web-map", "web-backend", "acme-prod"]
		expect(
			valuesOf("loadBalancing", [
				point(lb, "gcp.loadbalancing.https.request_count", "200", 75),
				point(lb, "gcp.loadbalancing.https.request_count", "500", 25),
			])[0],
		).toMatchObject({ Requests: 100, "5xx rate": 0.25 })
	})

	it("reads failures as everything outside the healthy label value", () => {
		expect(
			valuesOf("cloudFunctions", [
				point(API, "gcp.cloudfunctions.function.execution_count", "ok", 90),
				point(API, "gcp.cloudfunctions.function.execution_count", "timeout", 6),
				point(API, "gcp.cloudfunctions.function.execution_count", "crash", 4),
			])[0],
		).toMatchObject({ Executions: 100, "Error rate": 0.1 })
		// A pull subscription makes no push requests: there is no rate to show.
		expect(
			valuesOf("pubsub", [
				point(["orders", "acme-prod"], "gcp.pubsub.subscription.num_undelivered_messages", "", 0, 60),
			])[0],
		).toMatchObject({ Backlog: 0, Delivered: 0, "Push errors": undefined })
	})

	it("turns CPU seconds per minute into cores and keeps to non-evictable memory", () => {
		const container = ["api", "default", "prod", "acme-prod", "europe-west1"]
		expect(
			valuesOf("gke", [
				// 30 CPU seconds in each of 10 minutes.
				point(container, "gcp.kubernetes.container.cpu.core_usage_time", "", 300, 10),
				point(container, "gcp.kubernetes.container.memory.used_bytes", "non-evictable", 5120, 10),
				point(container, "gcp.kubernetes.container.memory.used_bytes", "evictable", 99_999, 10),
			])[0],
		).toMatchObject({ "CPU cores": 0.5, Memory: 512, Restarts: 0, "CPU of limit": undefined })
	})

	it("reads Cloud SQL connections from whichever engine metric reported", () => {
		const db = ["acme-prod:main", "acme-prod", "europe-west1"]
		const connections = (metric: string) =>
			valuesOf("cloudSql", [point(db, `gcp.cloudsql.database.${metric}`, "", 240, 60)])[0]?.Connections
		expect(connections("network.connections")).toBe(4)
		expect(connections("postgresql.num_backends")).toBe(4)
	})
})

describe("sortGcpWorkloads", () => {
	const rows = gcpWorkloads("cloudRun", [
		point(["b"], "gcp.run.request_count", "2xx", 10),
		point(["b"], "gcp.run.request_latencies", "0.95", 50),
		point(["a"], "gcp.run.request_count", "2xx", 30),
		point(["c"], "gcp.run.request_count", "2xx", 20),
		point(["c"], "gcp.run.request_latencies", "0.95", 90),
	])
	const names = (key: string, dir: "asc" | "desc") =>
		sortGcpWorkloads("cloudRun", rows, { key, dir }).map((row) => row.keys[0])

	it("sorts by a column in either direction", () => {
		expect(names("Requests", "desc")).toEqual(["a", "c", "b"])
		expect(names("Requests", "asc")).toEqual(["b", "c", "a"])
	})

	it("sorts by name", () => {
		expect(names(GCP_NAME_SORT, "asc")).toEqual(["a", "b", "c"])
		expect(names(GCP_NAME_SORT, "desc")).toEqual(["c", "b", "a"])
	})

	it("keeps a workload that never reported the column last in both directions", () => {
		expect(names("Latency p95", "desc")).toEqual(["c", "b", "a"])
		expect(names("Latency p95", "asc")).toEqual(["b", "c", "a"])
	})
})

describe("formatGcpValue", () => {
	it("formats by unit and marks an absent value", () => {
		expect(formatGcpValue("count", 12_345)).toBe("12.3K")
		expect(formatGcpValue("percent", 0.42)).toBe("42%")
		expect(formatGcpValue("errorRate", 0.001)).toBe("0.10%")
		expect(formatGcpValue("ms", 1500)).toBe("1.50s")
		expect(formatGcpValue("seconds", 90)).toBe("1.5min")
		expect(formatGcpValue("bytes", 1536)).toBe("1.5 KB")
		expect(formatGcpValue("bytes", undefined)).toBe("—")
	})
})

describe("gcpInfraTabs", () => {
	it("shows the reporting services in tab order, then the inventory", () => {
		expect(gcpInfraTabs(["cloudSql", "cloudRun"], undefined)).toEqual(["cloudRun", "cloudSql", "resources"])
		expect(gcpInfraTabs([], undefined)).toEqual(["resources"])
	})

	it("keeps the requested tab when its service is quiet in the window", () => {
		expect(gcpInfraTabs(["cloudRun"], "gke")).toEqual(["cloudRun", "gke", "resources"])
		expect(gcpInfraTabs(["cloudRun"], "resources")).toEqual(["cloudRun", "resources"])
	})
})

describe("gcpInfraNotice", () => {
	const connector = (last_metrics_received_at: string | null, last_metrics_error: string | null) => ({
		scope_type: "project" as const,
		metrics_enabled: true,
		last_metrics_received_at,
		last_metrics_error,
		discovered_project_count: 1,
		last_resources_error: null,
	})
	const READ_AT = "2026-10-08T09:10:00.000Z"

	it("says nothing while metrics arrive for the window", () => {
		expect(gcpInfraNotice([connector(READ_AT, null)], true)).toBeNull()
	})

	it("waits for the first read, with the poller's reason", () => {
		expect(gcpInfraNotice([connector(null, "No access yet.")], false)).toEqual({
			kind: "waiting",
			note: "No access yet.",
		})
		expect(gcpInfraNotice([connector(null, null)], false)).toEqual({ kind: "waiting", note: null })
	})

	it("tells a quiet window from a connector that never read", () => {
		expect(gcpInfraNotice([connector(null, null), connector(READ_AT, null)], false)).toEqual({
			kind: "quiet",
		})
	})

	it("reports a failing read even while other metrics arrive", () => {
		expect(
			gcpInfraNotice([connector(READ_AT, null), connector(READ_AT, "2 of 46 queries failed.")], true),
		).toEqual({ kind: "error", error: "2 of 46 queries failed." })
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

	it("surfaces the first failing inventory sync", () => {
		expect(gcpResourcesError([{ last_resources_error: null }])).toBeNull()
		expect(
			gcpResourcesError([{ last_resources_error: null }, { last_resources_error: "incomplete" }]),
		).toBe("incomplete")
	})
})
