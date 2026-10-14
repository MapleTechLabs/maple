import { describe, expect, it } from "vitest"
import { fillGoldenSignals, type GoldenSignalRow } from "./golden-signals"

const MINUTE = 60_000
const start = Date.parse("2026-10-13T12:00:00Z")
const window = { startMs: start, endMs: start + 4 * MINUTE, bucketSeconds: 60 }

const row = (bucketMs: number, count: number): GoldenSignalRow => ({
	bucketMs,
	count,
	errorRate: 0.1,
	p50Ms: 5,
	p95Ms: 20,
	p99Ms: 40,
	apdexScore: 0.9,
})

describe("fillGoldenSignals", () => {
	it("emits one point per bucket and fills the gaps as zero traffic", () => {
		const points = fillGoldenSignals([row(start, 3), row(start + 2 * MINUTE, 7)], window)

		expect(points.map((p) => p.bucket)).toEqual(
			[0, 1, 2, 3, 4].map((i) => new Date(start + i * MINUTE).toISOString()),
		)
		expect(points.map((p) => p.throughput)).toEqual([3, 0, 7, 0, 0])
		expect(points[1]).toMatchObject({ errorRate: 0, p95LatencyMs: 0, apdexScore: 0 })
		expect(points[2]).toMatchObject({
			errorRate: 0.1,
			p50LatencyMs: 5,
			p95LatencyMs: 20,
			p99LatencyMs: 40,
		})
	})

	it("marks empty buckets with a zero totalCount so the charts can trim an in-flight one", () => {
		const points = fillGoldenSignals([row(start, 3)], window)

		expect(points.map((p) => p.totalCount)).toEqual([3, 0, 0, 0, 0])
	})

	it("follows the window, so a narrower start drops the earlier buckets", () => {
		const narrowed = fillGoldenSignals([row(start, 3), row(start + 3 * MINUTE, 9)], {
			...window,
			startMs: start + 3 * MINUTE,
		})

		expect(narrowed.map((p) => p.throughput)).toEqual([9, 0])
	})
})
