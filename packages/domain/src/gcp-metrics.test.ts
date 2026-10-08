import { describe, expect, it } from "vitest"
import { GCP_ASSET_TYPES, GCP_METRIC_GROUPS, GCP_PROJECT_ASSET_TYPE } from "./gcp-metrics"

describe("GCP_METRIC_GROUPS", () => {
	const metrics = GCP_METRIC_GROUPS.flatMap((group) => group.metrics)

	it("names every metric after its Cloud Monitoring type, under gcp.", () => {
		const names = Object.fromEntries(metrics.map((metric) => [metric.type, metric.name]))
		expect(names).toMatchObject({
			"run.googleapis.com/request_count": "gcp.run.request_count",
			"kubernetes.io/container/cpu/core_usage_time": "gcp.kubernetes.container.cpu.core_usage_time",
			"cloudsql.googleapis.com/database/postgresql/num_backends":
				"gcp.cloudsql.database.postgresql.num_backends",
		})
		expect(new Set(Object.values(names)).size).toBe(metrics.length)
		expect(new Set(Object.keys(names)).size).toBe(metrics.length)
	})

	it("aligns counters and distributions as deltas, gauges as means", () => {
		for (const metric of metrics) {
			expect(metric.aligner, metric.type).toBe(metric.kind === "gauge" ? "ALIGN_MEAN" : "ALIGN_DELTA")
			if (metric.kind !== "gauge") expect(metric.reducer, metric.type).toBe("REDUCE_SUM")
		}
	})

	it("never groups by the project itself: every query adds it", () => {
		for (const group of GCP_METRIC_GROUPS) expect(group.resourceLabels).not.toContain("project_id")
	})
})

describe("GCP_ASSET_TYPES", () => {
	it("lists projects, which is how a folder or organization scope is discovered", () => {
		expect(GCP_ASSET_TYPES).toContain(GCP_PROJECT_ASSET_TYPE)
		expect(new Set(GCP_ASSET_TYPES).size).toBe(GCP_ASSET_TYPES.length)
	})
})
