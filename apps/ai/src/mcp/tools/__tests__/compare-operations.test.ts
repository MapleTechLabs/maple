import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Array as Arr, Schema, String as Str } from "effect"
import { CompareOperationsOutput } from "@maple/domain/mcp-outputs"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { installFakeWarehouse, restoreWarehouse } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import type { McpToolResult } from "../types"

const AROUND = "2026-09-24 06:00:00"
const DEPLOY_MS = Math.floor((Date.now() - 20 * 60_000) / 1000) * 1000
const DEPLOYED_AT = formatWarehouseDateTime(DEPLOY_MS)

const op = (spanName: string, spanCount: number, errorCount = 0, p95DurationMs = 40) => ({
	spanName,
	spanCount: String(spanCount),
	estimatedSpanCount: spanCount,
	errorCount: String(errorCount),
	estimatedErrorCount: errorCount,
	errorRate: spanCount > 0 ? errorCount / spanCount : 0,
	avgDurationMs: p95DurationMs / 2,
	p50DurationMs: p95DurationMs / 2,
	p95DurationMs,
	p99DurationMs: p95DurationMs * 2,
})

const before = [op("GET /cart", 5000, 5), op("POST /checkout", 1000, 2, 120)]
const after = [
	op("GET /cart", 5000, 5),
	op("POST /checkout", 1000, 2, 400),
	op("POST /payments/retry", 300, 120),
]

const version = (commitSha: string, firstSeen: string) => ({
	serviceName: "checkout",
	environment: "production",
	commitSha,
	firstSeen,
	lastSeen: firstSeen,
	spanCount: "1000",
	errorCount: "5",
	p50LatencyMs: 10,
	p95LatencyMs: 50,
	p99LatencyMs: 90,
	apdexSatisfiedCount: 900,
	apdexToleratingCount: 50,
})

/** The around_time case's before window starts at 05:30; the deploy case reads both sides alike. */
const isBefore = (sql: string) => Str.includes("05:30:00")(sql)

const opSql: string[] = []
let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse([
		{
			match: (sql) => Str.includes("AS commitSha")(sql),
			rows: [
				version("b".repeat(40), DEPLOYED_AT),
				version("a".repeat(40), formatWarehouseDateTime(Date.now() - 3 * 86_400_000)),
			],
		},
		{
			match: (sql) => Str.includes("operation_windows")(sql) && (opSql.push(sql), true),
			rows: (sql) => (isBefore(sql) ? before : after),
		},
	])
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (params: Record<string, unknown>) =>
	runToolDirect(rt, "compare_operations", params) as Promise<McpToolResult>
const decode = (result: McpToolResult) =>
	Schema.decodeUnknownSync(CompareOperationsOutput)(result.structuredContent)

describe("compare_operations", () => {
	it("flags the new failing operation first, then the slower one, and links the traces behind it", async () => {
		const result = await call({ service: "checkout", around_time: AROUND })
		const output = decode(result)
		expect(Arr.map(output.operations, (o) => [o.operation, o.flags])).toEqual([
			["POST /payments/retry", ["new", "errors_up"]],
			["POST /checkout", ["slower"]],
		])
		expect(output.unchanged).toBe(1)
		expect(output.after.spans).toBe(6300)

		const text = markdown(result)
		expect(text).toContain("40.00%")
		expect(text).toContain(
			'search_traces service="checkout" span_name="POST /payments/retry" has_error=true',
		)
		expect(text).toContain('compare_log_patterns service="checkout" previous_start="2026-09-24 05:30:00"')
	})

	it("splits at the newest deploy, scoped to its environment", async () => {
		opSql.length = 0
		const result = await call({ service: "checkout", since_deploy: true })
		const output = decode(result)
		expect(output.deploy?.firstSeen).toBe(DEPLOYED_AT)
		expect(output.environment).toBe("production")
		expect(output.after.timeRange.start).toBe(DEPLOYED_AT)
		expect(opSql).toHaveLength(2)
		expect(Arr.every(opSql, (sql) => Str.includes("'production'")(sql))).toBe(true)
		expect(markdown(result)).toContain(
			'compare_log_patterns service="checkout" since_deploy=true environment="production"',
		)
	})
})
