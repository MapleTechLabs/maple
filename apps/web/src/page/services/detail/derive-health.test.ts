import { describe, expect, test } from "vitest"
import type { DetailPoint } from "../../kit/service-metrics/points"
import { deriveHealth } from "./derive-health"

const START = Date.parse("2026-11-15T11:00:00Z")

const point = (index: number, patch: Partial<DetailPoint> = {}): DetailPoint => ({
	bucket: new Date(START + index * 60_000).toISOString(),
	throughput: 600,
	tracedThroughput: 600,
	hasSampling: false,
	samplingWeight: 1,
	errorRate: 0.002,
	p50LatencyMs: 10,
	p95LatencyMs: 40,
	p99LatencyMs: 80,
	apdexScore: 0.99,
	totalCount: 600,
	partial: false,
	...patch,
})

/** Past every bucket the tests draw. */
const END = START + 60 * 60_000

const steady = (count: number) => Array.from({ length: count }, (_, index) => point(index))

describe("deriveHealth", () => {
	test("requests read per second, not per bucket", () => {
		expect(deriveHealth(steady(10), END)?.throughput.now).toBe(10)
	})

	test("now is the last complete bucket: the filling one is skipped", () => {
		const points = [...steady(9), point(9, { partial: true, errorRate: 0.5 })]
		expect(deriveHealth(points, END)?.errorRate.now).toBe(0.002)
	})

	test("an error rate well above the window's turns critical", () => {
		const points = [...steady(9), point(9, { errorRate: 0.05 })]
		expect(deriveHealth(points, END)?.errorRate.tone).toBe("crit")
	})

	test("a p95 a quarter above the window's typical bucket turns to a warning", () => {
		const points = [...steady(9), point(9, { p95LatencyMs: 90 })]
		const health = deriveHealth(points, END)
		expect(health?.p95.window).toBe(40)
		expect(health?.p95.tone).toBe("warn")
	})

	test("a steady window reads neutral throughout", () => {
		const health = deriveHealth(steady(10), END)
		expect([health?.errorRate.tone, health?.p95.tone, health?.apdex.tone]).toEqual([
			"neutral",
			"neutral",
			"neutral",
		])
	})

	test("a service that went quiet reads 0/s now, in red, with no other figures", () => {
		const points = [...steady(9), point(9, { totalCount: 0, throughput: 0 })]
		const health = deriveHealth(points, END)
		expect(health?.throughput.now).toBe(0)
		expect(health?.throughput.tone).toBe("crit")
		expect(health?.errorRate.now).toBeNull()
	})

	test("the request average counts quiet buckets too", () => {
		const points = [
			...steady(5),
			...Array.from({ length: 5 }, (_, i) => point(5 + i, { totalCount: 0, throughput: 0 })),
		]
		expect(deriveHealth(points, END)?.throughput.window).toBe(5)
	})

	test("no traffic at all draws no strip", () => {
		expect(deriveHealth([point(0, { totalCount: 0, throughput: 0 })], END)).toBeNull()
	})

	test("a past range ending on a bucket boundary does not read its empty last bucket as an outage", () => {
		const points = [...steady(9), point(9, { totalCount: 0, throughput: 0 })]
		const health = deriveHealth(points, START + 9 * 60_000)
		expect(health?.throughput.now).toBe(10)
		expect(health?.throughput.tone).toBe("neutral")
	})

	test("a sparse service's empty latest bucket is no outage: it reads its last busy bucket", () => {
		// Traffic in every third minute, a few requests a minute, then an empty latest minute.
		const points = Array.from({ length: 12 }, (_, index) =>
			index % 3 === 0
				? point(index, { throughput: 180, totalCount: 180 })
				: point(index, { totalCount: 0, throughput: 0 }),
		)
		const health = deriveHealth(points, END)
		expect(health?.throughput.now).toBe(3)
		expect(health?.throughput.tone).toBe("neutral")
		expect(health?.errorRate.now).toBe(0.002)
	})

	test("a steady service silent for several buckets still reads as an outage", () => {
		const points = [
			...steady(9),
			...Array.from({ length: 3 }, (_, index) => point(9 + index, { totalCount: 0, throughput: 0 })),
		]
		const health = deriveHealth(points, END)
		expect(health?.throughput.now).toBe(0)
		expect(health?.throughput.tone).toBe("crit")
	})

	test("one busy bucket then silence is too little history to call an outage", () => {
		const points = [point(0), point(1, { totalCount: 0, throughput: 0 })]
		expect(deriveHealth(points, END)?.throughput.tone).toBe("neutral")
	})
})
