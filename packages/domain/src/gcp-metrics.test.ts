import { describe, expect, it } from "vitest"
import { GCP_METRIC_GROUPS } from "./gcp-metrics"

describe("GCP_METRIC_GROUPS", () => {
	const metrics = GCP_METRIC_GROUPS.flatMap((group) => group.metrics)

	it("reads every Cloud Monitoring type once", () => {
		expect(new Set(metrics.map((metric) => metric.type)).size).toBe(metrics.length)
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
