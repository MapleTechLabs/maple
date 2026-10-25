import { describe, expect, it } from "vitest"
import { GCP_METRIC_GROUPS, gcpMetricLabelAttribute } from "./gcp-metrics"

describe("GCP_METRIC_GROUPS", () => {
	const metrics = GCP_METRIC_GROUPS.flatMap((group) => group.metrics)

	it("reads every Cloud Monitoring type once, or a distribution once more for its count", () => {
		const readings = metrics.map((metric) => `${metric.type} ${metric.kind}`)
		expect(new Set(readings).size).toBe(metrics.length)
		const twice = metrics.filter(
			(metric) => metrics.filter((other) => other.type === metric.type).length > 1,
		)
		expect(twice.map((metric) => [metric.kind, metric.name])).toEqual([
			["quantiles", "gcp.cloud_sql.query.duration"],
			["sum", "gcp.cloud_sql.queries"],
			["quantiles", "gcp.cloud_sql.query.statement.duration"],
			["sum", "gcp.cloud_sql.query.statement.calls"],
		])
	})

	it("ranks a top group by one of its own metrics, and keeps its item on every metric", () => {
		const groups = GCP_METRIC_GROUPS.filter((group) => group.top !== undefined)
		expect(groups.map((group) => group.resourceType)).toEqual(["cloudsql_instance_database"])
		for (const { top, metrics: own } of groups) {
			expect(own.map((metric) => metric.name)).toContain(top!.by)
			for (const metric of own) expect(metric.labels, metric.name).toContain(top!.label)
		}
	})

	it("stores a statement's text under the semantic convention's attribute", () => {
		expect(gcpMetricLabelAttribute("querystring")).toBe("db.query.text")
		expect(gcpMetricLabelAttribute("query_hash")).toBe("gcp.metric.labels.query_hash")
	})

	it("tells types sharing a name apart by a constant attribute, except the per-engine connection gauges", () => {
		const typesByKey = new Map<string, Array<string>>()
		for (const metric of metrics) {
			const key = `${metric.name} ${JSON.stringify(metric.attributes)}`
			typesByKey.set(key, [...(typesByKey.get(key) ?? []), metric.type])
		}
		expect([...typesByKey.values()].filter((types) => types.length > 1)).toEqual([
			[
				"cloudsql.googleapis.com/database/network/connections",
				"cloudsql.googleapis.com/database/postgresql/num_backends",
			],
		])
	})

	it("defines a shared name once, since ingest merges its points into one metric", () => {
		const definitions = new Map<string, Set<string>>()
		for (const metric of metrics) {
			const definition = JSON.stringify([metric.kind, metric.unit, metric.description])
			definitions.set(metric.name, (definitions.get(metric.name) ?? new Set()).add(definition))
		}
		expect([...definitions].filter(([, distinct]) => distinct.size > 1)).toEqual([])
	})

	it("stores every duration in seconds", () => {
		expect(metrics.filter((metric) => ["ms", "us", "ns"].includes(metric.unit))).toEqual([])
	})

	it("never groups by the project itself: every query adds it", () => {
		for (const group of GCP_METRIC_GROUPS) expect(group.resourceLabels).not.toContain("project_id")
	})
})
