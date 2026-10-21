import { assert, describe, expect, test } from "vitest"
import type { SupabaseProjectTimeseriesRow } from "../model"
import { metricChartRows } from "../../kit/metric-charts"
import { CHARTS, visibleCharts } from "./charts"

const bucket = (
	iso: string,
	overrides: Partial<SupabaseProjectTimeseriesRow> = {},
): SupabaseProjectTimeseriesRow => ({
	bucket: iso,
	cpu: 0.25,
	memoryAvg: 0.5,
	memoryMax: 0.6,
	memoryTotal: 1e9,
	diskUsed: 0.14,
	diskSize: 8e9,
	dbSize: 1e7,
	connectionsAvg: 5,
	connectionsMax: 6,
	poolerClients: 2,
	commitsPerSecond: 1.5,
	rollbacksPerSecond: 0.1,
	cacheHitRatio: 0.99,
	authUsers: 0,
	authSamples: 0,
	postgrestPoolMax: 0,
	postgrestPoolInUse: 0,
	postgrestPoolWaiting: 0,
	networkRxPerSecond: 100,
	networkTxPerSecond: 50,
	diskReadPerSecond: 0,
	diskWritePerSecond: 10,
	...overrides,
})

const chart = (id: string) => {
	const found = CHARTS.find((entry) => entry.id === id)
	assert(found !== undefined, `no chart ${id}`)
	return found
}

describe("supabase project charts", () => {
	test("a bucket without block reads is a gap in the cache hit ratio, not a 0% dip", () => {
		const rows = metricChartRows(chart("Cache hit ratio"), [
			bucket("2026-10-01T10:00:00Z"),
			bucket("2026-10-01T10:05:00Z", { cacheHitRatio: null }),
		])
		expect(rows).toEqual([
			{ bucket: "2026-10-01T10:00:00Z", attributeValue: "Buffer cache hits", value: 0.99 },
		])
	})

	test("transactions draw commits and rollbacks per second", () => {
		expect(metricChartRows(chart("Transactions"), [bucket("2026-10-01T10:00:00Z")])).toEqual([
			{ bucket: "2026-10-01T10:00:00Z", attributeValue: "Commits", value: 1.5 },
			{ bucket: "2026-10-01T10:00:00Z", attributeValue: "Rollbacks", value: 0.1 },
		])
	})

	test("auth users and the PostgREST pool show only for projects that report them", () => {
		const quiet = visibleCharts([bucket("2026-10-01T10:00:00Z")]).map((entry) => entry.id)
		expect(quiet).not.toContain("Auth users")
		expect(quiet).not.toContain("PostgREST pool")
		const reporting = visibleCharts([
			bucket("2026-10-01T10:00:00Z", { authUsers: 12, authSamples: 5, postgrestPoolMax: 10 }),
		]).map((entry) => entry.id)
		expect(reporting).toContain("Auth users")
		expect(reporting).toContain("PostgREST pool")
	})
})
