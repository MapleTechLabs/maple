import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
	DbQueryVolumeOutput,
	IngestFreshnessOutput,
	IngestUsageOutput,
	RouteUsageOutput,
	ServiceDeploymentsOutput,
} from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { freshnessRow } from "../ingest-freshness"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"

const END = "2026-10-01 12:00:00"
const sqlSeen: string[] = []

// Each tool reads one distinctive table; the probe and history unions of ingest_freshness differ by table.
const fixtures: FixtureRule[] = [
	{
		match: (sql) => (sql.includes("totalSizeBytes") ? (sqlSeen.push(sql), true) : false),
		rows: [
			{
				serviceName: "api",
				totalLogCount: "10",
				totalLogSizeBytes: "1000",
				totalTraceCount: "200",
				totalTraceSizeBytes: "20000",
				totalSumMetricCount: "5",
				totalSumMetricSizeBytes: "50",
				totalGaugeMetricCount: "5",
				totalGaugeMetricSizeBytes: "50",
				totalHistogramMetricCount: "0",
				totalHistogramMetricSizeBytes: "0",
				totalExpHistogramMetricCount: "0",
				totalExpHistogramMetricSizeBytes: "0",
				totalSizeBytes: "21100",
			},
			{
				serviceName: "web",
				totalLogCount: "1",
				totalLogSizeBytes: "100",
				totalTraceCount: "20",
				totalTraceSizeBytes: "2000",
				totalSumMetricCount: "0",
				totalSumMetricSizeBytes: "0",
				totalGaugeMetricCount: "0",
				totalGaugeMetricSizeBytes: "0",
				totalHistogramMetricCount: "0",
				totalHistogramMetricSizeBytes: "0",
				totalExpHistogramMetricCount: "0",
				totalExpHistogramMetricSizeBytes: "0",
				totalSizeBytes: "2100",
			},
		],
	},
	{
		match: (sql) =>
			sql.includes("service_map_db_query_shapes_hourly") ? (sqlSeen.push(sql), true) : false,
		rows: [
			{
				serviceName: "api",
				dbSystem: "postgresql",
				dbNamespace: "maple",
				queryLabel: "SELECT * FROM users WHERE id = ?",
				queryCount: "900",
				estimatedQueryCount: 900,
				errorCount: "9",
				avgDurationMs: 2.5,
				p95DurationMs: 8,
				lastSeen: "2026-10-01 11:59:00",
			},
		],
	},
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
		match: (sql) => (sql.includes("metric_catalog") ? (sqlSeen.push(sql), true) : false),
		rows: [
			{ signal: "traces", count: "12", lastSeen: "2026-10-01 11:59:00" },
			{ signal: "metrics", count: "0", lastSeen: "1970-01-01 00:00:00" },
		],
	},
	{
		match: (sql) => /FROM logs\b/.test(sql),
		rows: [{ signal: "logs", count: "0", lastSeen: "1970-01-01 00:00:00" }],
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

	it("reads the hourly tier for a short window older than the minutely retention", async () => {
		const result = await call("service_deployments", {
			start_time: "2026-05-01 00:00:00",
			end_time: "2026-05-03 00:00:00",
		})
		const output = Schema.decodeUnknownSync(ServiceDeploymentsOutput)(result.structuredContent)
		expect(output.lastSeenPrecision).toBe("hour")
		expect(sqlSeen.at(-1)).toContain("service_overview_hourly")
	})

	it("caps versions per service and environment instead of only globally", async () => {
		await call("service_deployments", { end_time: END })
		expect(sqlSeen.at(-1)).toContain("PARTITION BY serviceName, environment")
		expect(sqlSeen.at(-1)).toContain("versionRank <= 20")
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
		expect(output.signals[0]?.lagSeconds).toBe(60)
		const probeSql = sqlSeen.at(-1) ?? ""
		expect(probeSql).toContain("FROM service_operations_minutely")
		expect(probeSql).toContain("metric_catalog.FirstSeen <= ")
		expect(probeSql).not.toMatch(/FROM logs\b/)
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

describe("db_query_volume", () => {
	it("ranks shapes across databases without a db_system", async () => {
		const result = await call("db_query_volume", { start_time: "2026-09-30 12:00:00", end_time: END })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(DbQueryVolumeOutput)(result.structuredContent)
		expect(output.queries[0]).toMatchObject({
			service: "api",
			dbSystem: "postgresql",
			calls: 900,
			p95Ms: 8,
		})
		expect(sqlSeen.at(-1)).not.toContain("DbSystem = ")
		expect(markdown(result)).toContain("| postgresql maple |")
	})

	it("passes db_system and service into both tiers", async () => {
		await call("db_query_volume", {
			db_system: "redis",
			service: "api",
			start_time: "2026-09-30 12:00:00",
			end_time: END,
		})
		const sql = sqlSeen.at(-1) ?? ""
		expect(sql).toContain("DbSystem = 'redis'")
		expect(sql).toContain("traces.ServiceName = 'api'")
	})
})

describe("ingest_usage", () => {
	it("folds the metric shapes together and totals every service", async () => {
		const result = await call("ingest_usage", { end_time: END })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(IngestUsageOutput)(result.structuredContent)
		expect(output.services[0]).toMatchObject({
			service: "api",
			traceCount: 200,
			metricCount: 10,
			metricBytes: 100,
		})
		expect(output.totals).toMatchObject({ traceCount: 220, logCount: 11, totalBytes: 23200 })
		expect(markdown(result)).toContain("| (all) | 220 |")
	})
})
