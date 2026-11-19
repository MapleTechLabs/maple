/**
 * `inspect_chart_data` fills in dashboard variables the way the board does before it runs a
 * widget, so a `$environment` filter is checked with a real value instead of the literal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import { CreateDashboardOutput, InspectChartDataOutput } from "@maple/domain/mcp-outputs"
import { makeEvalRuntime, runToolDirect, markdown, type EvalRuntime } from "./eval-runtime"
import { installFakeWarehouse, restoreWarehouse } from "./fake-warehouse"
import type { McpToolResult } from "../tools/types"
import {
	makeQueryBuilderTimeseriesDataSource,
	makeQueryDraft,
} from "@maple/backend/dashboard-templates/helpers"

let rt: EvalRuntime
const statements: string[] = []

beforeAll(() => {
	installFakeWarehouse(
		[
			{
				match: () => true,
				rows: (sql) => {
					statements.push(sql)
					// Only the raw-SQL tiles get rows; every query-builder read comes back empty.
					return Str.includes("count() AS value")(sql) ? [{ value: 3 }] : []
				},
			},
		],
		undefined,
		"empty",
	)
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: unknown): Promise<McpToolResult> => runToolDirect(rt, name, params)

const rawSqlWidget = (id: string, sql: string, x: number) => ({
	id,
	visualization: "table",
	dataSource: { kind: "raw_sql", sql },
	display: { title: id },
	layout: { x, y: 0, w: 4, h: 4 },
})

const document = {
	name: "Variables board",
	timeRange: { type: "relative", value: "6h" },
	variables: [
		{
			name: "environment",
			type: "custom",
			defaultValue: "production",
			includeAll: true,
			options: [{ value: "production" }, { value: "staging" }],
		},
		{ name: "region", type: "textbox" },
		{ name: "service", type: "query", source: { kind: "facet", facet: "service" } },
		{ name: "operation", type: "query", source: { kind: "facet", facet: "span_name" } },
	],
	widgets: [
		rawSqlWidget(
			"env",
			"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) AND deployment.environment IN ($environment)",
			0,
		),
		rawSqlWidget(
			"region",
			"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) AND cloud.region = $region",
			4,
		),
		{
			id: "builder",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "a",
					name: "A",
					dataSource: "traces",
					aggregation: "count",
					whereClause: "deployment.environment = $environment",
				}),
			]),
			display: { title: "builder" },
			layout: { x: 8, y: 0, w: 4, h: 4 },
		},
		{
			id: "by-region",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "a",
					name: "A",
					dataSource: "traces",
					aggregation: "count",
					whereClause: "cloud.region = $region",
				}),
			]),
			display: { title: "builder" },
			layout: { x: 0, y: 4, w: 4, h: 4 },
		},
		{
			id: "mixed",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "a",
					name: "A",
					dataSource: "traces",
					aggregation: "count",
					whereClause: "cloud.region = $region",
				}),
				makeQueryDraft({ id: "b", name: "B", dataSource: "traces", aggregation: "count" }),
			]),
			display: { title: "mixed" },
			layout: { x: 4, y: 4, w: 4, h: 4 },
		},
		{
			...rawSqlWidget(
				"service-pinned",
				"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) AND span.name = $operation",
				8,
			),
			timeRange: { type: "relative", value: "30m" },
		},
		rawSqlWidget(
			"service",
			"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) AND service.name = $service",
			4,
		),
	],
}

const lastTracesSql = (): string =>
	Option.getOrElse(
		Arr.findLast(statements, (sql) => Str.includes("FROM traces")(sql)),
		() => "(no traces read)",
	)

describe("inspect_chart_data with dashboard variables", () => {
	let dashboardId = ""

	beforeAll(async () => {
		const created = await call("create_dashboard", {
			name: "Variables board",
			dashboard_json: JSON.stringify(document),
			validate: "false",
		})
		expect(created.isError).toBeUndefined()
		dashboardId = Schema.decodeUnknownSync(CreateDashboardOutput)(created.structuredContent).dashboard.id
	})

	it("runs a widget with the variable's default and reports the value used", async () => {
		const result = await call("inspect_chart_data", { dashboard_id: dashboardId, widget_id: "env" })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(InspectChartDataOutput)(result.structuredContent)
		expect(output.rawSql?.status).toBe("ok")
		expect(output.variables).toEqual({ environment: "production" })
		expect(lastTracesSql()).toContain("IN ('production')")
		expect(lastTracesSql()).not.toContain("$environment")
		expect(markdown(result)).toContain('$environment = "production" (default)')
	})

	it("takes a value from `variables`, and expands All into the options", async () => {
		const staging = await call("inspect_chart_data", {
			dashboard_id: dashboardId,
			widget_id: "env",
			variables: { environment: "staging" },
		})
		expect(staging.isError).toBeUndefined()
		expect(lastTracesSql()).toContain("IN ('staging')")

		const all = await call("inspect_chart_data", {
			dashboard_id: dashboardId,
			widget_id: "env",
			variables: JSON.stringify({ environment: "$__all" }),
		})
		expect(Schema.decodeUnknownSync(InspectChartDataOutput)(all.structuredContent).variables).toEqual({
			environment: "$__all",
		})
		expect(lastTracesSql()).toContain("IN ('production','staging')")
	})

	it("fills a query-builder where-clause before the query runs", async () => {
		statements.length = 0
		const result = await call("inspect_chart_data", {
			dashboard_id: dashboardId,
			widget_id: "builder",
			variables: { environment: "staging" },
		})
		expect(result.isError).toBeUndefined()
		expect(statements.length).toBeGreaterThan(0)
		expect(Arr.some(statements, (sql) => Str.includes("'staging'")(sql))).toBe(true)
		expect(Arr.some(statements, (sql) => Str.includes("$environment")(sql))).toBe(false)
	})

	it("asks for a value when a referenced variable has none", async () => {
		const result = await call("inspect_chart_data", { dashboard_id: dashboardId, widget_id: "region" })
		expect(result.isError).toBeUndefined()
		expect(markdown(result)).toContain('Pass variables={"region":"<value>"}')
	})

	it("calls an empty result filtered on a variable with no value suspicious, not broken", async () => {
		const result = await call("inspect_chart_data", { dashboard_id: dashboardId, widget_id: "by-region" })
		const output = Schema.decodeUnknownSync(InspectChartDataOutput)(result.structuredContent)
		expect(Arr.some(output.flags, (flag) => flag === "EMPTY" || flag === "ALL_NULLS")).toBe(true)
		expect(output.verdict).toBe("suspicious")
		expect(markdown(result)).toContain('Pass variables={"region":"<value>"}')
	})

	it("keeps a widget broken when a query that uses no variable is empty too", async () => {
		const result = await call("inspect_chart_data", { dashboard_id: dashboardId, widget_id: "mixed" })
		const output = Schema.decodeUnknownSync(InspectChartDataOutput)(result.structuredContent)
		expect(output.verdict).toBe("broken")
	})

	it("re-checks with the same variable values it ran with", async () => {
		const result = await call("inspect_chart_data", {
			dashboard_id: dashboardId,
			widget_id: "by-region",
			variables: { region: "eu-west-1" },
		})
		expect(markdown(result)).toContain(String.raw`variables="{\"region\":\"eu-west-1\"}"`)
	})

	it("lists a query variable's options when nothing else gives it a value", async () => {
		statements.length = 0
		const result = await call("inspect_chart_data", { dashboard_id: dashboardId, widget_id: "service" })
		expect(result.isError).toBeUndefined()
		// The facet read ran first; the fake warehouse lists no services, so the ladder ends empty.
		expect(statements.length).toBeGreaterThan(1)
		expect(lastTracesSql()).toContain("service.name = ''")
		expect(markdown(result)).toContain("no default and no options in this window")
	})

	it("lists a pinned tile's variable options over the board's window, as the board does", async () => {
		statements.length = 0
		await call("inspect_chart_data", { dashboard_id: dashboardId, widget_id: "service-pinned" })
		const facetRead = Option.getOrElse(
			Arr.findFirst(statements, (sql) => Str.includes("facetType")(sql)),
			() => "",
		)
		const times = Arr.map(
			Array.from(Str.matchAll(/'(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})'/g)(facetRead)),
			(m) => Date.parse(`${m[1]}T${m[2]}Z`),
		)
		expect(times.length).toBeGreaterThan(1)
		// The board covers 6h; the tile pins 30m. (Its own variable, so no earlier listing is cached.)
		expect((Math.max(...times) - Math.min(...times)) / 3_600_000).toBeGreaterThan(5)
	})

	it("refuses a variable the dashboard does not declare", async () => {
		const result = await call("inspect_chart_data", {
			dashboard_id: dashboardId,
			widget_id: "env",
			variables: { team: "api" },
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("Unknown dashboard variable(s): team")
	})
})
