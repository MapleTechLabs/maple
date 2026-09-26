/**
 * The dashboard tools through the executor: typed output on `structuredContent`, the rendered
 * text, and input problems reported against the parameter that caused them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	CreateDashboardOutput,
	DescribeDashboardSchemaOutput,
	GetDashboardOutput,
	ListDashboardsOutput,
	RemoveDashboardWidgetOutput,
	ReorderDashboardWidgetsOutput,
} from "@maple/domain/mcp-outputs"
import { makeEvalRuntime, runToolDirect, markdown, type EvalRuntime } from "./eval-runtime"
import { installFakeWarehouse, restoreWarehouse } from "./fake-warehouse"
import type { McpToolResult } from "../tools/types"

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse([])
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: unknown): Promise<McpToolResult> => runToolDirect(rt, name, params)

const note = (id: string, x: number) => ({
	id,
	visualization: "markdown",
	dataSource: { kind: "static" },
	display: { title: `Note ${id}` },
	layout: { x, y: 0, w: 4, h: 4 },
})

const document = {
	name: "Eval board",
	timeRange: { type: "relative", value: "6h" },
	widgets: [note("w1", 0), note("w2", 4)],
}

describe("dashboard tools", () => {
	let dashboardId = ""

	it("creates from dashboard_json and reports the typed row", async () => {
		const result = await call("create_dashboard", {
			name: "Eval board",
			dashboard_json: JSON.stringify(document),
			validate: "false",
		})
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(CreateDashboardOutput)(result.structuredContent)
		expect(output.dashboard.widgetCount).toBe(2)
		expect(output.source).toBe("dashboard_json")
		expect(output.validation).toBeUndefined()
		dashboardId = output.dashboard.id

		const text = markdown(result)
		expect(text).toContain("## Dashboard Created")
		expect(text).toContain(`ID: ${dashboardId}`)
		expect(text).not.toContain("__maple_ui")
	})

	it("lists it with a next call that opens it", async () => {
		const result = await call("list_dashboards", { search: "eval" })
		const output = Schema.decodeUnknownSync(ListDashboardsOutput)(result.structuredContent)
		expect(output.dashboards.map((d) => d.id)).toContain(dashboardId)
		expect(markdown(result)).toContain(`\`get_dashboard dashboard_id="${dashboardId}"\``)
	})

	it("says what it searched when nothing matches", async () => {
		const result = await call("list_dashboards", { search: "no-such-board" })
		expect(markdown(result)).toContain('No dashboards found with a name containing "no-such-board".')
	})

	it("returns the document as a JSON block that round-trips", async () => {
		const result = await call("get_dashboard", { dashboard_id: dashboardId })
		const output = Schema.decodeUnknownSync(GetDashboardOutput)(result.structuredContent)
		expect(output.dashboard.widgets.map((w) => w.id)).toEqual(["w1", "w2"])
		expect(output.dashboard.tags).toEqual([])

		const text = markdown(result)
		expect(text).toContain("## Dashboard: Eval board")
		expect(text).toContain("```json\n")
	})

	it("reports an unknown dashboard against dashboard_id", async () => {
		const result = await call("get_dashboard", { dashboard_id: "nope" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toMatch(/^Invalid input \(`dashboard_id`\): Dashboard not found: nope/)
	})

	it("names the v3 replacement for a legacy data source", async () => {
		const result = await call("add_dashboard_widget", {
			dashboard_id: dashboardId,
			panel_type: "line",
			data_source_json: '{"endpoint":"custom_query_builder_timeseries","params":{"queries":[]}}',
			display_json: "{}",
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("legacy v2 data-source shape")
		expect(markdown(result)).toContain('"resultShape":"timeseries"')
	})

	it("rejects a panel type outside the enum at decode", async () => {
		const result = await call("add_dashboard_widget", {
			dashboard_id: dashboardId,
			panel_type: "chart",
			sql: "SELECT 1",
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("`panel_type`")
	})

	it("reorders, and rejects geometry off the grid", async () => {
		const bad = await call("reorder_dashboard_widgets", {
			dashboard_id: dashboardId,
			layouts_json: JSON.stringify([{ widget_id: "w1", x: 10, y: 0, w: 4, h: 4 }]),
		})
		expect(bad.isError).toBe(true)
		expect(markdown(bad)).toContain("x+w must not exceed 12")

		// The object form is accepted as well as JSON text.
		const ok = await call("reorder_dashboard_widgets", {
			dashboard_id: dashboardId,
			layouts_json: [{ widget_id: "w2", x: 0, y: 4, w: 6, h: 4 }],
		})
		const output = Schema.decodeUnknownSync(ReorderDashboardWidgetsOutput)(ok.structuredContent)
		expect(output.updatedWidgetIds).toEqual(["w2"])
	})

	it("removes a widget, and reports an unknown one against widget_id", async () => {
		const missing = await call("remove_dashboard_widget", { dashboard_id: dashboardId, widget_id: "w9" })
		expect(missing.isError).toBe(true)
		expect(markdown(missing)).toMatch(/^Invalid input \(`widget_id`\): Widget not found: w9/)

		const result = await call("remove_dashboard_widget", { dashboard_id: dashboardId, widget_id: "w1" })
		const output = Schema.decodeUnknownSync(RemoveDashboardWidgetOutput)(result.structuredContent)
		expect(output.dashboard.widgetCount).toBe(1)
		expect(markdown(result)).toContain("Removed Widget ID: w1")
	})

	it("rejects a time range the picker cannot express against time_range", async () => {
		const result = await call("update_dashboard", { dashboard_id: dashboardId, time_range: "forever" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toMatch(/^Invalid input \(`time_range`\)/)
	})

	it("serves a schema section under its own heading", async () => {
		const result = await call("describe_dashboard_schema", { section: "units" })
		const output = Schema.decodeUnknownSync(DescribeDashboardSchemaOutput)(result.structuredContent)
		expect(output.section).toBe("units")
		expect(markdown(result)).toMatch(/^## Units/)
	})

	it("inspects an unsupported widget by showing its stored data source", async () => {
		const result = await call("inspect_chart_data", { dashboard_id: dashboardId, widget_id: "w2" })
		expect(result.isError).toBeUndefined()
		expect(markdown(result)).toContain("not yet supported by inspect_chart_data")
		expect(markdown(result)).toContain('"kind": "static"')
	})
})
