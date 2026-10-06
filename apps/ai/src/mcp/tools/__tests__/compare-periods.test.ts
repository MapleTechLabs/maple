import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ComparePeriodsOutput } from "@maple/domain/mcp-outputs"
import { installFakeWarehouse, restoreWarehouse } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import type { McpToolResult } from "../types"

// Overall totals used to come from a different table than the per-service rows, so the two
// tables contradicted each other. Both now sum the same rows, scoped to `service` when given.

const row = (serviceName: string, throughput: number, errorCount: number) => ({
	serviceName,
	environment: "production",
	serviceNamespace: "",
	throughput: String(throughput),
	errorCount: String(errorCount),
	estimatedErrorCount: errorCount,
	spanCount: String(throughput),
	p50LatencyMs: 10,
	p95LatencyMs: 50,
	p99LatencyMs: 90,
	estimatedSpanCount: throughput,
	firstSeen: "2026-09-24 00:00:00",
	commits: [],
})

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse([
		{
			match: (sql) => sql.includes("06:00:00"),
			rows: [row("maple-api", 1000, 10), row("worker", 100, 0)],
		},
		{ match: () => true, rows: [row("maple-api", 1000, 5), row("worker", 19000, 0)] },
	])
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const WINDOW = { current_start: "2026-09-24 05:00:00", current_end: "2026-09-24 06:00:00" }
const call = (params: Record<string, unknown>) =>
	runToolDirect(rt, "compare_periods", params) as Promise<McpToolResult>

describe("compare_periods", () => {
	it("sums the overall totals from the per-service rows", async () => {
		const output = Schema.decodeUnknownSync(ComparePeriodsOutput)((await call(WINDOW)).structuredContent)
		expect(output.overall.current).toEqual({ totalSpans: 1100, totalErrors: 10, errorRate: 10 / 1100 })
		expect(output.overall.previous.totalSpans).toBe(20000)
	})

	it("scopes the overall totals to the requested service and labels the scope", async () => {
		const result = await call({ ...WINDOW, service: "maple-api" })
		const output = Schema.decodeUnknownSync(ComparePeriodsOutput)(result.structuredContent)
		expect(output.services.map((s) => s.name)).toEqual(["maple-api"])
		expect(output.overall.current.totalSpans).toBe(1000)
		expect(output.overall.previous.totalSpans).toBe(1000)
		expect(markdown(result)).toContain("entry spans")
	})
})
