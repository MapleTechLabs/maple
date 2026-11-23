import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Schema, String as Str } from "effect"
import { GetMetricExemplarsOutput } from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"

// The tool runs through the registry against a fake warehouse: the catalog read names the
// metric's type, the exemplar read answers with traces, highest value first.

const issued: Array<string> = []

const exemplar = (timestamp: string, value: number, traceId: string) => ({
	bucket: `${Str.slice(0, 16)(timestamp)}:00.000`,
	timestamp,
	value,
	traceId,
	spanId: `span_${traceId}`,
	serviceName: "checkout",
})

const catalogRow = (metricName: string, metricType: string) => ({
	metricName,
	metricType,
	serviceName: "checkout",
	metricDescription: "",
	metricUnit: "s",
	dataPointCount: 120,
	firstSeen: "2026-11-20 09:00:00",
	lastSeen: "2026-11-20 10:00:00",
	isMonotonic: 0,
})

const isCatalogRead = (sql: string): boolean => /\bmetric_catalog\b/i.test(sql)

const fixtures: FixtureRule[] = [
	{
		match: (sql) => {
			issued.push(sql)
			return false
		},
		rows: [],
	},
	{
		match: (sql) => isCatalogRead(sql) && Str.includes("http.server.request.duration")(sql),
		rows: [
			catalogRow("http.server.request.duration", "histogram"),
			catalogRow("http.server.request.duration.extra", "gauge"),
		],
	},
	{
		match: (sql) => isCatalogRead(sql) && Str.includes("quiet.metric")(sql),
		rows: [catalogRow("quiet.metric", "gauge")],
	},
	{
		match: (sql) => isCatalogRead(sql),
		rows: [catalogRow("http.server.request.duration", "histogram")],
	},
	{ match: (sql) => Str.includes("ExemplarsTraceId")(sql) && Str.includes("quiet.metric")(sql), rows: [] },
	{
		match: (sql) => Str.includes("ExemplarsTraceId")(sql),
		rows: [
			exemplar("2026-11-20 10:05:12.250", 4.2, "a".repeat(32)),
			exemplar("2026-11-20 10:05:40.000", 3.9, "a".repeat(32)),
			exemplar("2026-11-20 10:01:02.000", 1.5, "b".repeat(32)),
			exemplar("2026-11-20 10:02:03.000", 0.75, "c".repeat(32)),
		],
	},
]

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse(fixtures)
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (params: Record<string, unknown>) =>
	runToolDirect(rt, "get_metric_exemplars", params) as Promise<McpToolResult>

const window = { start_time: "2026-11-20 10:00:00", end_time: "2026-11-20 11:00:00" }

describe("get_metric_exemplars", () => {
	it("reads the metric's type from the catalog and lists its exemplars, highest first", async () => {
		const result = await call({ metric_name: "http.server.request.duration", ...window })
		const output = Schema.decodeUnknownSync(GetMetricExemplarsOutput)(result.structuredContent)
		expect(output.metricType).toBe("histogram")
		expect(output.exemplars.map((e) => e.value)).toEqual([4.2, 3.9, 1.5, 0.75])
		expect(output.exemplars[0]?.timestamp).toBe("2026-11-20 10:05:12.250")
		expect(output.truncated).toBe(false)
	})

	it("offers inspect_trace once per trace, at the exemplar's time", async () => {
		const result = await call({ metric_name: "http.server.request.duration", ...window })
		const text = markdown(result)
		expect(text).toContain(`inspect_trace trace_id="${"a".repeat(32)}" timestamp="2026-11-20 10:05:12"`)
		expect(text).toContain(`trace_id="${"b".repeat(32)}"`)
		expect(text.split(`inspect_trace trace_id="${"a".repeat(32)}"`)).toHaveLength(2)
	})

	it("skips the catalog read when the type is given, and scopes the read to the filters", async () => {
		const before = issued.length
		await call({
			metric_name: "http.server.request.duration",
			metric_type: "histogram",
			service: "checkout",
			attribute_key: "http.route",
			attribute_value: "/pay",
			...window,
		})
		const sqls = issued.slice(before)
		expect(sqls.filter(isCatalogRead)).toEqual([])
		const read = sqls.find((sql) => Str.includes("ExemplarsTraceId")(sql)) ?? ""
		expect(read).toContain("checkout")
		expect(read).toContain("/pay")
	})

	it("marks a list cut by the limit as truncated", async () => {
		const result = await call({ metric_name: "http.server.request.duration", limit: 2, ...window })
		const output = Schema.decodeUnknownSync(GetMetricExemplarsOutput)(result.structuredContent)
		expect(output.exemplars).toHaveLength(2)
		expect(output.truncated).toBe(true)
	})

	it("names similar metrics when the name is not in the catalog", async () => {
		const result = await call({ metric_name: "http.server.duration", ...window })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("http.server.request.duration")
	})

	it("points at find_slow_traces when the metric has no exemplars", async () => {
		const result = await call({ metric_name: "quiet.metric", ...window })
		const output = Schema.decodeUnknownSync(GetMetricExemplarsOutput)(result.structuredContent)
		expect(output.exemplars).toEqual([])
		expect(markdown(result)).toContain("find_slow_traces")
	})
})
