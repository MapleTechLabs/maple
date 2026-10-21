import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import { mergeSupabaseSeries } from "./supabase-infra-series"

const at = (iso: string) => DateTime.makeUnsafe(iso)

const gauge = (iso: string, memoryAvg: number) => ({
	bucket: at(iso),
	memoryAvg,
	memoryMax: memoryAvg,
	memoryTotal: 1024,
	diskUsed: 0.1,
	diskSize: 2048,
	dbSize: 512,
	connectionsAvg: 5,
	connectionsMax: 6,
	maxConnections: 60,
	poolerClients: 2,
	authUsers: 3,
	authSamples: 5,
	postgrestPoolMax: 10,
	postgrestPoolInUse: 1,
	postgrestPoolWaiting: 0,
})

const rate = (iso: string, cpu: number) => ({
	bucket: at(iso),
	cpu,
	commitsPerSecond: 1.5,
	rollbacksPerSecond: 0,
	cacheHitRatio: 0.99,
	networkRxPerSecond: 10,
	networkTxPerSecond: 20,
	diskReadPerSecond: 0,
	diskWritePerSecond: 30,
})

describe("mergeSupabaseSeries", () => {
	it("joins both reads on the bucket, in time order", () => {
		const rows = mergeSupabaseSeries(
			[gauge("2026-07-02T00:05:00Z", 0.6), gauge("2026-07-02T00:00:00Z", 0.5)],
			[rate("2026-07-02T00:00:00Z", 0.2), rate("2026-07-02T00:05:00Z", 0.3)],
		)
		expect(rows.map((row) => [row.bucket, row.memoryAvg, row.cpu])).toEqual([
			["2026-07-02T00:00:00.000Z", 0.5, 0.2],
			["2026-07-02T00:05:00.000Z", 0.6, 0.3],
		])
	})

	it("keeps a bucket only one read has, with the other half at zero", () => {
		const rows = mergeSupabaseSeries([], [rate("2026-07-02T00:00:00Z", 0.4)])
		expect(rows).toHaveLength(1)
		expect(rows[0]?.cpu).toBe(0.4)
		expect(rows[0]?.memoryAvg).toBe(0)
		expect(rows[0]?.dbSize).toBe(0)
	})

	it("leaves the cache hit ratio empty for a bucket only the gauges have", () => {
		const rows = mergeSupabaseSeries([gauge("2026-07-02T00:00:00Z", 0.5)], [])
		expect(rows[0]?.cacheHitRatio).toBeNull()
	})
})
