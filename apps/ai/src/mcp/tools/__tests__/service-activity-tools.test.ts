import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { IngestFreshnessOutput, RouteUsageOutput, ServiceDeploymentsOutput } from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { freshnessRow } from "../ingest-freshness"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"

const END = "2026-10-01 12:00:00"
const sqlSeen: string[] = []

// Each tool reads one distinctive table; the probe and history unions of ingest_freshness differ by table.
const fixtures: FixtureRule[] = [
	{
		match: (sql) => (sql.includes("AS commitSha") ? (sqlSeen.push(sql), true) : false),
		rows: [
			{
				serviceName: "api",
				environment: "production",
				commitSha: "bbbbbbbbbbbbbbbbbbbb",
				firstSeen: "2026-10-01 09:00:00",
				lastSeen: "2026-10-01 11:59:00",
				spanCount: "1000",
				errorCount: "50",
				p50LatencyMs: 10,
				p95LatencyMs: 120,
				p99LatencyMs: 300,
				apdexSatisfiedCount: 900,
				apdexToleratingCount: 50,
			},
			{
				serviceName: "api",
				environment: "production",
				commitSha: "aaaaaaaaaaaaaaaaaaaa",
				firstSeen: "2026-09-28 09:00:00",
				lastSeen: "2026-10-01 09:05:00",
				spanCount: 4000,
				errorCount: 40,
				p50LatencyMs: 9,
				p95LatencyMs: 80,
				p99LatencyMs: 200,
				apdexSatisfiedCount: 3900,
				apdexToleratingCount: 50,
			},
		],
	},
	{
		match: (sql) => (sql.includes("route_windows") ? (sqlSeen.push(sql), true) : false),
		rows: [
			{
				serviceName: "api",
				spanName: "GET /v1/users/{id}",
				spanCount: "200",
				errorCount: "4",
				p95DurationMs: 35,
				firstSeen: "2026-09-02 10:00:00",
				lastSeen: "2026-09-20 14:00:00",
			},
		],
	},
	{
		match: (sql) => sql.includes("metric_catalog"),
		rows: [
			{ signal: "traces", count: "12", lastSeen: "2026-10-01 11:59:30" },
			{ signal: "logs", count: "0", lastSeen: "1970-01-01 00:00:00" },
			{ signal: "metrics", count: "0", lastSeen: "1970-01-01 00:00:00" },
		],
	},
	{
		match: (sql) => sql.includes("service_usage"),
		rows: [
			{
				signal: "traces",
				count: "5000",
				firstSeen: "2026-09-25 00:00:00",
				lastSeen: "2026-10-01 12:00:00",
			},
			{
				signal: "logs",
				count: "300",
				firstSeen: "2026-09-25 00:00:00",
				lastSeen: "2026-10-01 08:00:00",
			},
			{
				signal: "metrics",
				count: "0",
				firstSeen: "1970-01-01 00:00:00",
				lastSeen: "1970-01-01 00:00:00",
			},
			{
				signal: "sessions",
				count: "0",
				firstSeen: "1970-01-01 00:00:00",
				lastSeen: "1970-01-01 00:00:00",
			},
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

const call = (name: string, params: Record<string, unknown>) =>
	runToolDirect(rt, name, params) as Promise<McpToolResult>

describe("service_deployments", () => {
	it("lists versions newest first, marks the live one and compares it with the previous", async () => {
		const result = await call("service_deployments", { service: "api", end_time: END })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(ServiceDeploymentsOutput)(result.structuredContent)
		expect(output.lastSeenPrecision).toBe("minute")
		expect(output.versions.map((v) => [v.commitSha.slice(0, 1), v.live])).toEqual([
			["b", true],
			["a", false],
		])
		expect(output.versions[0]?.errorRate).toBeCloseTo(0.05)
		const text = markdown(result)
		expect(text).toContain("Newest vs previous version")
		expect(text).toContain("+4.00 pp")
		expect(text).toContain('`compare_periods around_time="2026-10-01 09:00:00"')
		expect(sqlSeen.at(-1)).toContain("service_overview_minutely")
		expect(sqlSeen.at(-1)).not.toContain("service_overview_hourly")
	})

	it("adds the hourly tier past seven days", async () => {
		const result = await call("service_deployments", { start_time: "2026-09-10 12:00:00", end_time: END })
		const output = Schema.decodeUnknownSync(ServiceDeploymentsOutput)(result.structuredContent)
		expect(output.lastSeenPrecision).toBe("hour")
		expect(sqlSeen.at(-1)).toContain("service_overview_hourly")
	})
})

describe("route_usage", () => {
	it("splits method and route and reads the operations rollups", async () => {
		const result = await call("route_usage", { search: "/v1/", sort: "least_recent", end_time: END })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(RouteUsageOutput)(result.structuredContent)
		expect(output.routes[0]).toMatchObject({ method: "GET", route: "/v1/users/{id}", spanCount: 200 })
		expect(output.routes[0]?.errorRate).toBeCloseTo(0.02)
		expect(sqlSeen.at(-1)).toContain("service_operations_hourly")
		expect(sqlSeen.at(-1)).toContain("ORDER BY lastSeen ASC")
		expect(markdown(result)).toContain("`search_traces")
	})

	it("rejects an unknown sort and narrows a window past 90 days", async () => {
		const sort = await call("route_usage", { sort: "oldest" })
		expect(sort.isError).toBe(true)
		expect(markdown(sort)).toContain("`sort`")
		const wide = await call("route_usage", { start_time: "2026-06-01 00:00:00", end_time: END })
		expect(wide.isError).toBeUndefined()
		expect(markdown(wide)).not.toContain("2026-06-01 00:00:00")
	})
})

describe("ingest_freshness", () => {
	it("tells a receiving signal from a stalled one and one never sent", async () => {
		const result = await call("ingest_freshness", { end_time: END })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(IngestFreshnessOutput)(result.structuredContent)
		expect(output.probeWindow).toEqual({ start: "2026-10-01 11:00:00", end: END })
		expect(output.signals.map((s) => [s.signal, s.status])).toEqual([
			["traces", "receiving"],
			["logs", "stalled"],
			["metrics", "none"],
		])
		expect(output.signals[0]?.lagSeconds).toBe(30)
		expect(output.signals[1]?.lastHourWithData).toBe("2026-10-01 08:00:00")
		expect(markdown(result)).toContain("logs stopped while traces kept arriving")
	})

	it("calls a stale newest event delayed", () => {
		const row = freshnessRow(
			"traces",
			Date.parse("2026-10-01T12:00:00Z"),
			{ count: 3, lastSeen: "2026-10-01 11:40:00" },
			{ count: 3, lastSeen: "2026-10-01 11:00:00" },
		)
		expect(row).toMatchObject({ status: "delayed", lagSeconds: 1200 })
	})
})
