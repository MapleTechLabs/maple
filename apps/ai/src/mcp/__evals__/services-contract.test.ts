/**
 * The services, metrics and query tools on the `define` contract: each call's structuredContent
 * decodes with the tool's output schema, the text renders from it, and input problems come back
 * as invalid input naming the parameter.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	ComparePeriodsOutput,
	DescribeWarehouseTablesOutput,
	DiagnoseServiceOutput,
	ExploreAttributesOutput,
	GetServiceTopOperationsOutput,
	ListMetricsOutput,
	ListServicesOutput,
	QueryDataOutput,
	ServiceMapOutput,
} from "@maple/domain/mcp-outputs"
import { makeEvalRuntime, runToolDirect, markdown, type EvalRuntime } from "./eval-runtime"
import { installFakeWarehouse, restoreWarehouse } from "./fake-warehouse"
import type { McpToolResult } from "../tools/types"

let issuedSql: Array<string> = []
let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse([
		{
			match: (sql) => {
				issuedSql.push(sql)
				return false
			},
			rows: [],
		},
		// Everything else answers with no rows: the contract is the same either way.
		{ match: () => true, rows: [] },
	])
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: unknown): Promise<McpToolResult> => {
	issuedSql = []
	return runToolDirect(rt, name, params)
}

const WINDOW = { start_time: "2026-09-24 00:00:00", end_time: "2026-09-24 06:00:00" }

const cases: ReadonlyArray<
	readonly [string, Record<string, unknown>, Schema.Codec<unknown, unknown, never, never>, string]
> = [
	["list_services", WINDOW, ListServicesOutput, "## Services"],
	["diagnose_service", { ...WINDOW, service: "checkout" }, DiagnoseServiceOutput, "## Diagnosis: checkout"],
	[
		"get_service_top_operations",
		{ ...WINDOW, service: "checkout" },
		GetServiceTopOperationsOutput,
		"## Top Operations: checkout",
	],
	["service_map", WINDOW, ServiceMapOutput, "## Service Map"],
	["list_metrics", WINDOW, ListMetricsOutput, "## Available Metrics"],
	["explore_attributes", { ...WINDOW, source: "traces" }, ExploreAttributesOutput, "## Attribute Keys"],
	[
		"explore_attributes",
		{ ...WINDOW, source: "services" },
		ExploreAttributesOutput,
		"## Available Environments & Deployments",
	],
	[
		"compare_periods",
		{ current_start: "2026-09-24 05:00:00", current_end: "2026-09-24 06:00:00" },
		ComparePeriodsOutput,
		"## Period Comparison",
	],
	[
		"query_data",
		{ ...WINDOW, source: "traces", kind: "timeseries" },
		QueryDataOutput,
		"## Traces Timeseries: count",
	],
	["describe_warehouse_tables", {}, DescribeWarehouseTablesOutput, "## Warehouse tables"],
	["describe_warehouse_tables", { table: "traces" }, DescribeWarehouseTablesOutput, "## `traces`"],
]

describe("services, metrics and query tools on define", () => {
	for (const [name, params, schema, title] of cases) {
		it(`${name} ${JSON.stringify(params)} returns typed output and renders it`, async () => {
			const result = await call(name, params)
			expect(result.isError, markdown(result)).toBeUndefined()
			expect(() => Schema.decodeUnknownSync(schema)(result.structuredContent)).not.toThrow()
			const text = markdown(result)
			expect(text).toContain(title)
			expect(text).not.toContain("__maple_ui")
		})
	}

	it("accepts service_name as an alias of the required service", async () => {
		const result = await call("diagnose_service", { ...WINDOW, service_name: "checkout" })
		expect(result.isError).toBeUndefined()
		expect(Schema.decodeUnknownSync(DiagnoseServiceOutput)(result.structuredContent).serviceName).toBe(
			"checkout",
		)
		expect(issuedSql.join("\n")).toContain("checkout")
	})

	it("states the real 6-hour query_data default", async () => {
		const result = await call("query_data", { source: "traces", kind: "breakdown" })
		const output = Schema.decodeUnknownSync(QueryDataOutput)(result.structuredContent)
		expect(output.decisions?.[0]).toMatch(/^start_time: defaulted to 6 hours before end_time/)
	})

	it("clamps the query_data breakdown limit", async () => {
		const result = await call("query_data", {
			...WINDOW,
			source: "traces",
			kind: "breakdown",
			limit: 1000,
		})
		expect(result.isError).toBeUndefined()
		expect(Schema.decodeUnknownSync(QueryDataOutput)(result.structuredContent).queryContext.limit).toBe(
			100,
		)
	})

	it("reports group_by=attribute without a key as invalid input with an example", async () => {
		const result = await call("query_data", {
			source: "traces",
			kind: "breakdown",
			group_by: "attribute",
		})
		expect(result.isError).toBe(true)
		const text = markdown(result)
		expect(text).toMatch(/^Invalid input \(`attribute_key`\): /)
		expect(text).toContain('group_by="attribute" attribute_key="http.method"')
	})

	const METRIC = { ...WINDOW, source: "metrics", metric_name: "jobs_processed_total" }

	it("warns that metric=sum over a counter adds running totals", async () => {
		const result = await call("query_data", {
			...METRIC,
			kind: "timeseries",
			metric: "sum",
			metric_type: "sum",
		})
		const output = Schema.decodeUnknownSync(QueryDataOutput)(result.structuredContent)
		expect(output.warnings?.[0]).toContain("metric=increase")
		expect(markdown(result)).toContain("Warnings")
	})

	it("runs an increase breakdown per pod on a gauge-stored counter", async () => {
		const result = await call("query_data", {
			...METRIC,
			kind: "breakdown",
			metric: "increase",
			metric_type: "gauge",
			group_by: "resource_attribute",
			attribute_key: "k8s.pod.name",
			environments: ["production"],
		})
		expect(result.isError, markdown(result)).toBeUndefined()
		const sql = issuedSql.join("\n")
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain("with_deltas")
		expect(sql).toContain("k8s.pod.name")
		expect(sql).toContain("'production'")
	})

	it("rejects rate on a histogram with a pointer to count", async () => {
		const result = await call("query_data", {
			...METRIC,
			kind: "timeseries",
			metric: "rate",
			metric_type: "histogram",
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("needs a counter")
	})

	it("lists one metric's own labels for explore_attributes source=metrics", async () => {
		const result = await call("explore_attributes", {
			...WINDOW,
			source: "metrics",
			metric_name: "worker_busy",
			metric_type: "gauge",
			service: "jobs",
		})
		expect(result.isError, markdown(result)).toBeUndefined()
		const sql = issuedSql.join("\n")
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain("'worker_busy'")
		expect(sql).toContain("'jobs'")
		const text = markdown(result)
		expect(text).toContain("metrics (worker_busy)")
		expect(text).not.toContain("(span)")
	})

	it("returns nothing, not the org-wide rollup, for a metric missing from the catalog", async () => {
		const result = await call("explore_attributes", {
			...WINDOW,
			source: "metrics",
			metric_name: "not_a_metric",
			service: "jobs",
		})
		expect(result.isError, markdown(result)).toBeUndefined()
		const sql = issuedSql.join("\n")
		expect(sql).toContain("FROM metric_catalog")
		expect(sql).toContain("'jobs'")
		expect(sql).not.toContain("attribute_keys_hourly")
		expect(markdown(result)).toContain("No attribute keys found for not_a_metric")
	})

	it("reports SQL without the org filter as invalid input on `sql`", async () => {
		const result = await call("run_sql", { sql: "SELECT count() FROM traces" })
		expect(result.isError).toBe(true)
		const text = markdown(result)
		expect(text).toMatch(/^Invalid input \(`sql`\): SQL rejected \(MissingOrgFilter\)/)
		expect(text).toContain("$__orgFilter AND $__timeFilter(Timestamp)")
	})

	it("names the tables when describe_warehouse_tables gets an unknown one", async () => {
		const result = await call("describe_warehouse_tables", { table: "otel_traces" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toMatch(
			/^Invalid input \(`table`\): No table named "otel_traces"\. Did you mean "traces"\? Available tables: /,
		)
	})

	it("rejects a current window that ends before it starts", async () => {
		const result = await call("compare_periods", {
			current_start: "2026-09-24 06:00:00",
			current_end: "2026-09-24 05:00:00",
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toMatch(/^Invalid input \(`current_start`\): /)
	})
})
