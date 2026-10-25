import { describe, expect, it } from "vitest"
import { DateTime } from "effect"
import { apiTrafficResponse, mergeSupabaseCallers, mergeSupabaseProjects } from "./supabase-insights-merge"

const REF_METRICS = "abcdefghijklmnopqrst"
const REF_LOGS_ONLY = "bcdefghijklmnopqrstu"
const at = (iso: string) => DateTime.makeUnsafe(iso)

const gauges = {
	projectRef: REF_METRICS,
	memoryAvg: 0.5,
	memoryMax: 0.6,
	memoryTotal: 1024,
	diskUsedMax: 0.1,
	diskSize: 2048,
	dbSize: 512,
	connectionsAvg: 4,
	connectionsMax: 7,
	maxConnections: 60,
	lastSeen: at("2026-10-21T12:00:00Z"),
}

const callerRow = (serviceName: string, calls: number) => ({
	serviceName,
	calls,
	callsPerMinute: calls / 60,
	errors: 0,
	errorRate: 0,
	p95DurationMs: 12,
	rest: calls,
	auth: 0,
	storage: 0,
	realtime: 0,
	functions: 0,
	postgres: 0,
	other: 0,
})

describe("mergeSupabaseProjects", () => {
	it("adds log counts to metric rows and lists projects that only have logs", () => {
		const rows = mergeSupabaseProjects(
			[gauges],
			[{ projectRef: REF_METRICS, cpuAvg: 0.2, cpuMax: 0.4 }],
			[
				{
					projectRef: REF_LOGS_ONLY,
					requests: 120,
					requestsPerMinute: 2,
					errors5xx: 1,
					issueCount: 9,
					lastSeen: at("2026-10-21T11:59:00Z"),
				},
			],
		)
		expect(rows).toEqual([
			{
				...gauges,
				cpuAvg: 0.2,
				cpuMax: 0.4,
				requests: 0,
				requestsPerMinute: 0,
				errors5xx: 0,
				issueCount: 0,
				lastSeen: "2026-10-21T12:00:00.000Z",
			},
			{
				projectRef: REF_LOGS_ONLY,
				cpuAvg: 0,
				cpuMax: 0,
				memoryAvg: 0,
				memoryMax: 0,
				memoryTotal: 0,
				diskUsedMax: 0,
				diskSize: 0,
				dbSize: 0,
				connectionsAvg: 0,
				connectionsMax: 0,
				maxConnections: 0,
				requests: 120,
				requestsPerMinute: 2,
				errors5xx: 1,
				issueCount: 9,
				lastSeen: "2026-10-21T11:59:00.000Z",
			},
		])
	})
})

describe("apiTrafficResponse", () => {
	it("derives the 5xx rate from the totals and reads an empty window as zeros", () => {
		expect(apiTrafficResponse([], { requests: 200, errors5xx: 5, p95OriginMs: 30 }).errorRate5xx).toBe(
			0.025,
		)
		const empty = apiTrafficResponse([], undefined)
		expect([empty.requests, empty.errorRate5xx, empty.p95OriginMs]).toEqual([0, 0, 0])
	})
})

describe("mergeSupabaseCallers", () => {
	it("gives each caller only its own buckets, keeping the callers' order", () => {
		const callers = mergeSupabaseCallers(
			[callerRow("api", 90), callerRow("worker", 10)],
			[
				{ serviceName: "worker", bucket: "2026-10-21T12:00:00.000000Z", calls: 10 },
				{ serviceName: "api", bucket: "2026-10-21T12:00:00.000000Z", calls: 40 },
				{ serviceName: "api", bucket: "2026-10-21T12:05:00.000000Z", calls: 50 },
			],
		)
		expect(
			callers.map((caller) => [caller.serviceName, caller.series.map((point) => point.calls)]),
		).toEqual([
			["api", [40, 50]],
			["worker", [10]],
		])
		expect(callers[0]?.mix.rest).toBe(90)
	})
})
