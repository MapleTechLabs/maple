import { describe, expect, test } from "vitest"
import type { CheckPoint } from "./model"
import { percentileSeries } from "./view-panels"

const bucket = (index: number, totalCount: number): CheckPoint => ({
	bucket: new Date(Date.UTC(2026, 9, 27, 13, index)).toISOString(),
	errorRate: 0,
	p50LatencyMs: 100,
	p95LatencyMs: 200,
	p99LatencyMs: 300,
	totalCount,
	partial: false,
})

const labels = (counts: ReadonlyArray<number>) =>
	percentileSeries(counts.map((count, index) => bucket(index, count))).map((entry) => entry.label)

describe("response time lines", () => {
	test("one check a bucket is a single response time line", () => {
		expect(labels([1, 1, 0, 1, 2])).toEqual(["Response time"])
	})

	test("a few checks a bucket drops P99, which would trace their slowest", () => {
		expect(labels([9, 8, 0, 9])).toEqual(["P95", "P50"])
	})

	test("busy buckets draw every percentile", () => {
		expect(labels([60, 60, 61])).toEqual(["P99", "P95", "P50"])
	})

	test("empty buckets do not count toward the typical bucket", () => {
		expect(labels([0, 0, 0, 0, 60, 60])).toEqual(["P99", "P95", "P50"])
	})
})
