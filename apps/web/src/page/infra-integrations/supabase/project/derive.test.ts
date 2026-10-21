import { SupabaseApiTrafficBucket, SupabaseCallerMix } from "@maple/domain/http"
import { describe, expect, test } from "vitest"
import type { SupabaseProjectTimeseriesRow } from "../model"
import { CONNECTIONS_CHART, TRANSACTIONS_CHART } from "./charts"
import { callerMixText, healthStrip, rollbackShare, trafficShares } from "./derive"
import { metricChartRows } from "../../kit/metric-charts"

const mix = (overrides: Partial<SupabaseCallerMix>) =>
	new SupabaseCallerMix({
		rest: 0,
		auth: 0,
		storage: 0,
		realtime: 0,
		functions: 0,
		postgres: 0,
		other: 0,
		...overrides,
	})

const bucket = (
	iso: string,
	overrides: Partial<SupabaseProjectTimeseriesRow> = {},
): SupabaseProjectTimeseriesRow => ({
	bucket: iso,
	cpu: 0.2,
	memoryAvg: 0.5,
	memoryMax: 0.6,
	memoryTotal: 2 * 1024 ** 3,
	diskUsed: 0.3,
	diskSize: 8e9,
	dbSize: 1e9,
	connectionsAvg: 20,
	connectionsMax: 25,
	maxConnections: 90,
	poolerClients: 40,
	commitsPerSecond: 9,
	rollbacksPerSecond: 1,
	cacheHitRatio: 0.99,
	authUsers: 0,
	authSamples: 0,
	postgrestPoolMax: 0,
	postgrestPoolInUse: 0,
	postgrestPoolWaiting: 0,
	networkRxPerSecond: 0,
	networkTxPerSecond: 0,
	diskReadPerSecond: 0,
	diskWritePerSecond: 0,
	...overrides,
})

describe("callerMixText", () => {
	test("names the largest products first with their share", () => {
		expect(callerMixText(mix({ rest: 71, postgres: 29 }))).toBe("REST 71% · Postgres 29%")
		expect(callerMixText(mix({ postgres: 94 }))).toBe("Postgres 100%")
	})

	test("keeps the three largest and says nothing without calls", () => {
		expect(callerMixText(mix({ rest: 50, auth: 20, storage: 20, realtime: 10 }))).toBe(
			"REST 50% · Auth 20% · Storage 20%",
		)
		expect(callerMixText(mix({}))).toBe("")
	})
})

describe("trafficShares", () => {
	test("each status class's share of the window", () => {
		const buckets = [
			new SupabaseApiTrafficBucket({
				bucket: "a",
				status2xx: 90,
				status3xx: 0,
				status4xx: 6,
				status5xx: 2,
			}),
			new SupabaseApiTrafficBucket({
				bucket: "b",
				status2xx: 0,
				status3xx: 0,
				status4xx: 0,
				status5xx: 2,
			}),
		]
		expect(trafficShares(buckets).map(({ status, share }) => [status, share])).toEqual([
			["2xx", 0.9],
			["3xx", 0],
			["4xx", 0.06],
			["5xx", 0.04],
		])
	})
})

describe("healthStrip", () => {
	test("CPU averages the window and remembers when it peaked; cache hit skips buckets without reads", () => {
		const strip = healthStrip([
			bucket("2026-10-01T10:00:00Z", { cpu: 0.1, dbSize: 1e9 }),
			bucket("2026-10-01T10:05:00Z", { cpu: 0.4, cacheHitRatio: 0.95, dbSize: 1.2e9 }),
			bucket("2026-10-01T10:10:00Z", {
				cpu: 0.1,
				cacheHitRatio: null,
				connectionsMax: 31,
				dbSize: 1.25e9,
			}),
		])
		expect(strip?.cpu.avg).toBeCloseTo(0.2)
		expect(strip?.cpu.peak?.bucket).toBe("2026-10-01T10:05:00Z")
		expect(strip?.cacheHit.ratio).toBe(0.95)
		expect(strip?.connections).toMatchObject({ peak: 31, limit: 90 })
		expect(strip?.dbSize.growth).toBe(0.25e9)
	})

	test("a bucket without CPU increments is a gap in the spark, left out of the average", () => {
		const strip = healthStrip([
			bucket("2026-10-01T10:00:00Z", { cpu: 0.3 }),
			bucket("2026-10-01T10:05:00Z", { cpu: null }),
		])
		expect(strip?.cpu.avg).toBeCloseTo(0.3)
		expect(strip?.cpu.spark.map((point) => point.value)).toEqual([0.3, null])
		expect(healthStrip([bucket("2026-10-01T10:00:00Z", { cpu: null })])?.cpu).toMatchObject({
			avg: null,
			peak: null,
		})
	})

	test("no buckets is no strip", () => {
		expect(healthStrip([])).toBeNull()
	})
})

describe("postgres charts", () => {
	test("the connections chart draws the limit only for buckets that reported it", () => {
		const rows = metricChartRows(CONNECTIONS_CHART, [
			bucket("2026-10-01T10:00:00Z", { maxConnections: 90 }),
			bucket("2026-10-01T10:05:00Z", { maxConnections: null }),
		])
		expect(rows.filter((entry) => entry.attributeValue === "Limit")).toEqual([
			{ bucket: "2026-10-01T10:00:00Z", attributeValue: "Limit", value: 90 },
		])
	})

	test("a bucket holding a counter's first sample is a gap in transactions, not a 0/s dip", () => {
		const rows = metricChartRows(TRANSACTIONS_CHART, [
			bucket("2026-10-01T10:00:00Z", { commitsPerSecond: null, rollbacksPerSecond: null }),
			bucket("2026-10-01T10:05:00Z"),
		])
		expect(rows.map((entry) => entry.bucket)).toEqual(["2026-10-01T10:05:00Z", "2026-10-01T10:05:00Z"])
	})

	test("rollback share over the window, none without transactions", () => {
		expect(rollbackShare([bucket("a"), bucket("b")])).toBeCloseTo(0.1)
		expect(rollbackShare([bucket("a", { commitsPerSecond: 0, rollbacksPerSecond: 0 })])).toBeNull()
	})
})
