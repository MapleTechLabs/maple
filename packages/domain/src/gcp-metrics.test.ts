import { describe, expect, it } from "vitest"
import { GCP_METRIC_GROUPS } from "./gcp-metrics"

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
		// No type twice, and no two types under one name.
		expect(Object.keys(names)).toHaveLength(metrics.length)
		expect(new Set(Object.values(names)).size).toBe(metrics.length)
	})

	it("never groups by the project itself: every query adds it", () => {
		for (const group of GCP_METRIC_GROUPS) expect(group.resourceLabels).not.toContain("project_id")
	})
})
