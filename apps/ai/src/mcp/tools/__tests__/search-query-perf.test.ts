import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest"
import { Array as Arr, Schema, String as Str } from "effect"
import { formatWarehouseDateTime } from "@maple/query-engine"
import {
	DiagnoseServiceOutput,
	InspectTraceOutput,
	QueryDataOutput,
	SearchTracesOutput,
} from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { installFakeWarehouse, readsTraceSpans, restoreWarehouse } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"

// The tools run through the registry against a fake warehouse that records every statement,
// so each case asserts what reached the warehouse as well as what the agent reads.

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const SPAN_ID = "00f067aa0ba902b7"
const chTime = formatWarehouseDateTime
const TRACE_MS = Date.now() - 2 * 3_600_000

let seen: Array<string> = []
/** span_search rows per call: exact predicates get `exactRows`, substring ones `containsRows`. */
let exactRows: ReadonlyArray<unknown> = []
let containsRows: ReadonlyArray<unknown> = []

const spanRow = (spanName: string) => ({
	traceId: TRACE_ID,
	spanId: SPAN_ID,
	spanName,
	serviceName: "api",
	durationMs: 12,
	statusCode: "Ok",
	statusMessage: "",
	spanAttributes: {},
	resourceAttributes: {},
	timestamp: `${chTime(TRACE_MS)}.000000000`,
})

const isSpanSearch = (sql: string) => /\bFROM traces\b/.test(sql) && Str.includes("min(ts)")(sql)
const isProbe = (sql: string) => Str.includes("FROM trace_index")(sql) && !/\bFROM traces\b/.test(sql)

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse(
		[
			{
				match: (sql) => {
					seen.push(sql)
					return false
				},
				rows: [],
			},
			// diagnose_service's recent traces: the root-span list read.
			{
				match: (sql) => Str.includes("AS durationMicros")(sql) && Str.includes("AS rootSpanId")(sql),
				rows: [
					{
						traceId: TRACE_ID,
						startTime: `${chTime(TRACE_MS)}.000000000`,
						endTime: `${chTime(TRACE_MS)}.000000000`,
						durationMicros: 12_000,
						spanCount: 1,
						services: ["api"],
						rootSpanId: SPAN_ID,
						rootSpanName: "GET /orders",
						rootSpanKind: "Server",
						rootSpanStatusCode: "Error",
						rootSpanStatusMessage: "",
						rootHttpMethod: "GET",
						rootHttpRoute: "/orders",
						rootHttpStatusCode: "500",
						rootSpanAttributes: "{}",
						rootDeploymentEnv: "production",
						rootServiceVersion: "1.0.0",
						hasError: 1,
					},
				],
			},
			{
				match: isSpanSearch,
				rows: (sql) => (Str.includes("positionCaseInsensitive")(sql) ? containsRows : exactRows),
			},
			{
				match: isProbe,
				rows: [
					{
						traceId: TRACE_ID,
						timestamp: `${chTime(TRACE_MS)}.000000000`,
						endTimestamp: `${chTime(TRACE_MS + 1000)}.000000000`,
					},
				],
			},
			{
				match: (sql) => readsTraceSpans(sql) && Str.includes(TRACE_ID)(sql),
				rows: [
					{
						traceId: TRACE_ID,
						spanId: SPAN_ID,
						parentSpanId: "",
						spanName: "GET /orders",
						rawSpanName: "http.server GET",
						serviceName: "api",
						spanKind: "Server",
						durationMs: 12,
						startTime: `${chTime(TRACE_MS)}.000000000`,
						statusCode: "Unset",
						statusMessage: "",
						spanAttributes: JSON.stringify({
							"http.route": "/orders",
							"http.response.status_code": "200",
							"cache.result": "hit",
						}),
						resourceAttributes: "{}",
						relationship: "related",
					},
				],
			},
		],
		undefined,
		"empty",
	)
	rt = makeEvalRuntime()
})

beforeEach(() => {
	seen = []
	exactRows = []
	containsRows = []
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: Record<string, unknown>) =>
	runToolDirect(rt, name, params) as Promise<McpToolResult>

// One hour, so span-level search runs as a single statement rather than newest-hour-first.
const window = { start_time: chTime(TRACE_MS - 1_800_000), end_time: chTime(TRACE_MS + 1_800_000) }

describe("search_traces span_name", () => {
	it("matches the exact name through the span-name index and never reads substrings on a hit", async () => {
		exactRows = [spanRow("checkout")]
		const result = await call("search_traces", { ...window, span_name: "checkout" })
		const output = Schema.decodeUnknownSync(SearchTracesOutput)(result.structuredContent)
		expect(output.traces).toHaveLength(1)
		expect(output.filters.spanNameMatch).toBe("exact")
		const searches = Arr.filter(seen, isSpanSearch)
		expect(searches).toHaveLength(1)
		expect(searches[0]).toContain("traces.SpanName = 'checkout'")
		expect(searches[0]).not.toContain("positionCaseInsensitive")
	})

	it("falls back to a substring when no span has the exact name, and pages on in that mode", async () => {
		containsRows = Arr.makeBy(2, () => spanRow("CheckoutHandler.run"))
		const result = await call("search_traces", { ...window, span_name: "checkout", limit: 2 })
		const output = Schema.decodeUnknownSync(SearchTracesOutput)(result.structuredContent)
		expect(output.filters.spanNameMatch).toBe("contains")
		expect(Arr.filter(seen, isSpanSearch)).toHaveLength(2)
		const text = markdown(result)
		expect(text).toContain('contains "checkout"')
		expect(text).toContain('span_name_match="contains"')
	})

	it("runs only the substring search when it is asked for", async () => {
		containsRows = [spanRow("CheckoutHandler.run")]
		await call("search_traces", { ...window, span_name: "checkout", span_name_match: "contains" })
		const searches = Arr.filter(seen, isSpanSearch)
		expect(searches).toHaveLength(1)
		expect(searches[0]).toContain("positionCaseInsensitive(traces.SpanName, 'checkout')")
	})
})

describe("query_data aliases", () => {
	const decisions = (result: McpToolResult) =>
		Schema.decodeUnknownSync(QueryDataOutput)(result.structuredContent).decisions ?? []

	it("reads group_by=commit_sha as the commit resource attribute", async () => {
		const result = await call("query_data", {
			...window,
			source: "traces",
			kind: "breakdown",
			group_by: "commit_sha",
			service: "api",
		})
		expect(result.isError).not.toBe(true)
		expect(decisions(result).join("\n")).toContain('attribute_key="vcs.ref.head.revision"')
		expect(seen.join("\n")).toContain("ResourceAttributes['vcs.ref.head.revision']")
	})

	it("reads a dotted group_by as an attribute key", async () => {
		const result = await call("query_data", {
			...window,
			source: "traces",
			kind: "breakdown",
			group_by: "http.route",
			attribute_scope: "span",
			service: "api",
		})
		expect(result.isError).not.toBe(true)
		expect(seen.join("\n")).toContain("SpanAttributes['http.route']")
	})

	it("reads metric=error_count as a count of error spans", async () => {
		const result = await call("query_data", {
			...window,
			source: "traces",
			kind: "timeseries",
			metric: "error_count",
		})
		expect(result.isError).not.toBe(true)
		expect(decisions(result).join("\n")).toContain('metric="count" over error spans')
		expect(seen.join("\n")).toContain("StatusCode = 'Error'")
	})

	it("breaks logs down by a log attribute", async () => {
		const result = await call("query_data", {
			...window,
			source: "logs",
			kind: "breakdown",
			group_by: "attribute",
			attribute_key: "http.route",
			attribute_scope: "span",
			service: "api",
		})
		expect(result.isError).not.toBe(true)
		expect(seen.join("\n")).toContain("LogAttributes['http.route']")
	})

	it("narrows a breakdown past the 30-day cap before running it", async () => {
		const result = await call("query_data", {
			source: "traces",
			kind: "breakdown",
			group_by: "status_code",
			service: "api",
			start_time: "2026-05-01 00:00:00",
			end_time: "2026-06-05 00:00:00",
		})
		expect(decisions(result).join("\n")).toContain(
			"start_time: moved to 2026-05-06 00:00:00; a breakdown covers at most 30 days",
		)
	})
})

describe("inspect_trace without a timestamp", () => {
	it("locates the trace in trace_index first, bounded to the last day's partitions", async () => {
		const result = await call("inspect_trace", { trace_id: TRACE_ID })
		const output = Schema.decodeUnknownSync(InspectTraceOutput)(result.structuredContent)
		expect(output.spanCount).toBe(1)
		expect(seen[0] !== undefined && isProbe(seen[0])).toBe(true)
		expect(seen[0]).toContain("trace_index.Bucket >= toStartOfFiveMinutes(")
		expect(output.scanned?.widened).toBe(false)
	})

	it("keeps the root span's HTTP attributes in the output and trims them only in the text", async () => {
		const result = await call("inspect_trace", { trace_id: TRACE_ID })
		const output = Schema.decodeUnknownSync(InspectTraceOutput)(result.structuredContent)
		expect(output.spans[0]?.attributes).toMatchObject({
			"http.route": "/orders",
			"http.response.status_code": "200",
			"cache.result": "hit",
		})
		const text = markdown(result)
		expect(text).toContain("cache.result=hit")
		expect(text).not.toContain("http.route=/orders")
	})
})

describe("diagnose_service recent traces", () => {
	it("keeps each trace's start in the output the inspect_trace hint is built from", async () => {
		const result = await call("diagnose_service", { ...window, service: "api" })
		const output = Schema.decodeUnknownSync(DiagnoseServiceOutput)(result.structuredContent)
		expect(output.recentTraces[0]?.startTime).toMatch(new RegExp(`^${chTime(TRACE_MS)}`))
	})
})
