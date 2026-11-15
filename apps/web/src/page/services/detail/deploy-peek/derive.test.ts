import { describe, expect, test } from "vitest"
import { Array as Arr } from "effect"
import type { Operation } from "../model-tabs"
import { operationChanges } from "./derive"
import { afterSeconds, sidesOf } from "./update"

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
		op("GET /rarely", 5, 0, 30),
	]
	const after = [
		op("POST /batch", 700, 0.1, 85),
		op("GET /depots", 400, 0, 4),
		op("GET /routes", 600, 0.001, 51),
		op("GET /cache", 200, 0, 2),
		op("GET /rare", 5, 1, 900),
		op("GET /rarely", 400, 0, 31),
	]
	const changes = operationChanges(before, after, 50)

	test("worst change first: errors up, new, too few before to compare, faster, steady", () => {
		expect(Arr.map(changes, (change) => [change.spanName, change.change])).toEqual([
			["POST /batch", "errors-up"],
			["GET /cache", "new"],
			["GET /rarely", "few-before"],
			["GET /depots", "faster"],
			["GET /routes", "steady"],
		])
	})

	test("an operation too quiet after the deploy, or gone from it, is left out", () => {
		const names = Arr.map(changes, (change) => change.spanName)
		expect(names).not.toContain("GET /rare")
		expect(names).not.toContain("GET /retired")
	})

	test("missing from a before list cut at its cap is no baseline, not new", () => {
		const capped = Arr.map(Arr.range(1, 3), (index) => op(`GET /busy${index}`, 1000, 0, 20))
		const [change] = operationChanges(capped, [op("GET /quiet-before", 200, 0, 20)], 3)
		expect(change?.change).toBe("few-before")
	})

	test("a p95 a quarter higher and 10ms more reads slower", () => {
		const [change] = operationChanges([op("GET /x", 100, 0, 40)], [op("GET /x", 100, 0, 60)], 50)
		expect(change?.change).toBe("slower")
	})
})

describe("sidesOf", () => {
	const MINUTE = 60_000
	const DEPLOY = Date.UTC(2026, 10, 15, 12)
	const check = { firstSeenMs: DEPLOY + 20_000, windowMinutes: 30 }

	test("a settled deploy compares its full half hour after with the half hour before", () => {
		expect(sidesOf(check, DEPLOY + 3 * 60 * MINUTE)).toEqual({
			before: { startMs: DEPLOY - 30 * MINUTE, endMs: DEPLOY },
			after: { startMs: DEPLOY, endMs: DEPLOY + 30 * MINUTE },
		})
	})

	test("while it verifies, the after side stops where the data does", () => {
		expect(sidesOf(check, DEPLOY + 10 * MINUTE).after).toEqual({
			startMs: DEPLOY,
			endMs: DEPLOY + 10 * MINUTE,
		})
	})

	test("in its first minute the after side still spans one minute", () => {
		expect(sidesOf(check, DEPLOY + 30_000).after).toEqual({ startMs: DEPLOY, endMs: DEPLOY + MINUTE })
	})
})

describe("afterSeconds", () => {
	const DEPLOY = Date.UTC(2026, 10, 15, 12)
	const check = { firstSeenMs: DEPLOY + 20_000, windowMinutes: 30 }

	test("90 seconds in, the after side holds 90 seconds of traffic, not one floored minute", () => {
		expect(afterSeconds(check, DEPLOY + 90_000)).toBe(90)
	})

	test("a settled deploy holds its full window", () => {
		expect(afterSeconds(check, DEPLOY + 3 * 60 * 60_000)).toBe(1800)
	})

	test("just shipped, a few seconds at least", () => {
		expect(afterSeconds(check, DEPLOY + 1_000)).toBe(5)
	})
})
