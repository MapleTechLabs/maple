import { describe, expect, test } from "vitest"
import { Array as Arr } from "effect"
import type { Operation } from "../model-tabs"
import { operationChanges } from "./derive"

const op = (spanName: string, spanCount: number, errorRate: number, p95DurationMs: number): Operation => ({
	spanName,
	spanCount,
	estimatedSpanCount: spanCount,
	errorCount: Math.round(spanCount * errorRate),
	estimatedErrorCount: Math.round(spanCount * errorRate),
	errorRate,
	avgDurationMs: p95DurationMs / 2,
	p50DurationMs: p95DurationMs / 3,
	p95DurationMs,
	sparkline: [],
})

describe("operationChanges", () => {
	const before = [
		op("POST /batch", 1000, 0.002, 80),
		op("GET /depots", 500, 0, 40),
		op("GET /routes", 800, 0.001, 50),
		op("GET /retired", 300, 0, 10),
	]
	const after = [
		op("POST /batch", 700, 0.1, 85),
		op("GET /depots", 400, 0, 4),
		op("GET /routes", 600, 0.001, 51),
		op("GET /cache", 200, 0, 2),
		op("GET /rare", 5, 1, 900),
	]
	const changes = operationChanges(before, after)

	test("worst change first: errors up, then new, then faster, then steady", () => {
		expect(Arr.map(changes, (change) => [change.spanName, change.change])).toEqual([
			["POST /batch", "errors-up"],
			["GET /cache", "new"],
			["GET /depots", "faster"],
			["GET /routes", "steady"],
		])
	})

	test("an operation too quiet after the deploy, or gone from it, is left out", () => {
		const names = Arr.map(changes, (change) => change.spanName)
		expect(names).not.toContain("GET /rare")
		expect(names).not.toContain("GET /retired")
	})

	test("a p95 a quarter higher and 10ms more reads slower", () => {
		const [change] = operationChanges([op("GET /x", 100, 0, 40)], [op("GET /x", 100, 0, 60)])
		expect(change?.change).toBe("slower")
	})
})
