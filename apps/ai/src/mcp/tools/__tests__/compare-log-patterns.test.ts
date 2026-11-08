import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Array as Arr, Schema, String as Str } from "effect"
import { CompareLogPatternsOutput } from "@maple/domain/mcp-outputs"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { installFakeWarehouse, restoreWarehouse } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import type { McpToolResult } from "../types"
import { templateProbe } from "../compare-log-patterns"

// The deploy is relative to now: `since_deploy` reads its boundary against the server clock.
const DEPLOYED_AT = formatWarehouseDateTime(Date.now() - 20 * 60_000)
const AROUND = "2026-09-24 06:00:00"

const logRow = (body: string, severityText = "INFO") => ({
	timestamp: AROUND,
	exactTimestamp: AROUND,
	severityText,
	severityNumber: severityText === "ERROR" ? 17 : 9,
	serviceName: "checkout",
	body,
	traceId: "",
	spanId: "",
	recordIdentity: "0123456789ABCDEF0123456789ABCDEF",
	logAttributes: "{}",
	resourceAttributes: "{}",
})

const steady = Arr.flatMap(Arr.range(1, 300), (i) => [
	logRow(`GET /api/cart/${i} 200 in ${i % 90}ms`),
	logRow(`user ${1000 + i} logged in`),
])
const afterRows = [
	...steady,
	...Arr.map(Arr.range(1, 40), (i) => logRow(`payment failed for order ${i}: card declined`, "ERROR")),
]

/** The earliest timestamp literal in a statement: before-window reads start earlier than after-window ones. */
const earliest = (sql: string, boundary: string) =>
	Arr.some(sql.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g) ?? [], (t) => t < boundary)

const sqlSeen: string[] = []

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse([
		{
			match: (sql) => Str.includes("AS commitSha")(sql),
			rows: [
				{
					serviceName: "checkout",
					environment: "production",
					commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					firstSeen: DEPLOYED_AT,
					lastSeen: DEPLOYED_AT,
					spanCount: "1000",
					errorCount: "5",
					p50LatencyMs: 10,
					p95LatencyMs: 50,
					p99LatencyMs: 90,
					apdexSatisfiedCount: 900,
					apdexToleratingCount: 50,
				},
			],
		},
		{
			match: (sql) => /\bfrom\s+logs/i.test(sql) && Str.includes(" AS total")(sql),
			rows: (sql) => [{ total: earliest(sql, boundaryOf(sql)) ? 6000 : 6400 }],
		},
		{
			match: (sql) => /\bfrom\s+logs\b/i.test(sql) && (sqlSeen.push(sql), true),
			rows: (sql) => (earliest(sql, boundaryOf(sql)) ? steady : afterRows),
		},
	])
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const boundaryOf = (sql: string) => (Str.includes(DEPLOYED_AT)(sql) ? DEPLOYED_AT : AROUND)

const call = (params: Record<string, unknown>) =>
	runToolDirect(rt, "compare_log_patterns", params) as Promise<McpToolResult>
const decode = (result: McpToolResult) =>
	Schema.decodeUnknownSync(CompareLogPatternsOutput)(result.structuredContent)

describe("compare_log_patterns", () => {
	it("lists the template that appeared after the boundary, scaled to the window's total", async () => {
		const result = await call({ around_time: AROUND })
		const output = decode(result)
		expect(output.before.timeRange).toEqual({ start: "2026-09-24 05:30:00", end: AROUND })
		expect(output.after.timeRange).toEqual({ start: AROUND, end: "2026-09-24 06:30:00" })
		expect(Arr.map(output.patterns, (p) => p.change)).toEqual(["new"])
		const [pattern] = output.patterns
		expect(pattern?.template).toContain("payment failed for order")
		// 40 of 640 sampled logs, scaled to 6400 in the window.
		expect(pattern?.after).toEqual({ sampled: 40, estimated: 400 })
		expect(output.unchanged).toBe(2)

		const text = markdown(result)
		expect(text).toContain("NEW")
		expect(text).toContain(
			'search_logs service="checkout" severity="ERROR" search="payment failed for order"',
		)
	})

	it("splits at the service's newest deploy and scopes logs to its environment", async () => {
		sqlSeen.length = 0
		const result = await call({ since_deploy: true, service: "checkout" })
		const output = decode(result)
		expect(output.deploy).toEqual({
			service: "checkout",
			environment: "production",
			commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			firstSeen: DEPLOYED_AT,
		})
		expect(output.environment).toBe("production")
		expect(output.after.timeRange.start).toBe(DEPLOYED_AT)
		expect(output.before.timeRange.end).toBe(DEPLOYED_AT)
		expect(Arr.every(sqlSeen, (sql) => Str.includes("'production'")(sql))).toBe(true)
		// compare_commits is offered to Maple's own agents only, so only their render suggests it.
		expect(markdown(result)).not.toContain("compare_commits")
		const chat = await runToolDirect(
			rt,
			"compare_log_patterns",
			{ since_deploy: true, service: "checkout" },
			"chat",
		)
		expect(markdown(chat)).toContain('compare_commits service="checkout" environment="production"')
	})

	it("refuses since_deploy without a service", async () => {
		const result = await call({ since_deploy: true })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("`since_deploy` needs `service`")
	})

	it("refuses a period wider than a day", async () => {
		const result = await call({
			current_start: "2026-09-20 00:00:00",
			current_end: "2026-09-24 00:00:00",
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("at most 24")
	})
})

describe("templateProbe", () => {
	it("picks the longest literal run of a template", () => {
		expect(templateProbe("payment failed for order <*>: card declined")).toBe("payment failed for order")
		expect(templateProbe("<*> <*> ok")).toBeUndefined()
	})
})
