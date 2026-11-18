import { describe, expect, test } from "vitest"
import { isGrafanaDashboardJson, isPersesDashboardJson } from "./portable"

const grafana = { title: "Node", schemaVersion: 39, panels: [{ type: "stat" }] }

describe("which importer a dashboard file goes to", () => {
	test("Grafana: a board with panels or old rows and a schemaVersion, or the API envelope", () => {
		expect(isGrafanaDashboardJson(grafana)).toBe(true)
		expect(isGrafanaDashboardJson({ title: "Old", schemaVersion: 14, rows: [] })).toBe(true)
		expect(isGrafanaDashboardJson({ dashboard: { panels: [] }, meta: { slug: "node" } })).toBe(true)
	})

	test("not Grafana: Maple JSON, Perses, or panels without a schema version", () => {
		const maple = { name: "Maple", timeRange: { type: "relative", value: "6h" }, widgets: [] }
		const perses = { kind: "Dashboard", spec: { panels: {} } }
		expect(isGrafanaDashboardJson(maple)).toBe(false)
		expect(isGrafanaDashboardJson(perses)).toBe(false)
		expect(isGrafanaDashboardJson({ panels: [] })).toBe(false)
		expect(isGrafanaDashboardJson([grafana])).toBe(false)
		expect(isPersesDashboardJson(grafana)).toBe(false)
	})
})
