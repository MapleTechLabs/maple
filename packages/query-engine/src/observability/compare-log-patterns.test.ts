import { describe, expect, it } from "vitest"
import { Array as Arr, Record as Rec } from "effect"
import { diffLogPatterns, hasErrorSeverity } from "./compare-log-patterns"

const log = (body: string, severityText = "INFO", serviceName = "checkout") => ({
	body,
	severityText,
	serviceName,
})

/** `n` logs of each steady template, with varying tokens so Drain masks them. */
const steady = (n: number) =>
	Arr.flatMap(Arr.range(1, n), (i) => [
		log(`GET /api/cart/${i} 200 in ${i % 90}ms`),
		log(`user ${1000 + i} logged in`),
		log(`flushed ${i} spans to exporter`),
	])

const repeat = (n: number, body: (i: number) => string, severity = "INFO") =>
	Arr.map(Arr.range(1, n), (i) => log(body(i), severity))

describe("diffLogPatterns", () => {
	it("flags a template that only appears after the boundary, error templates first", () => {
		const before = steady(1000)
		const after = [
			...steady(1000),
			...repeat(40, (i) => `cache miss for key session:${i}`),
			...repeat(30, (i) => `payment failed for order ${i}: card declined`, "ERROR"),
		]
		const diff = diffLogPatterns(
			{ rows: before, total: before.length },
			{ rows: after, total: after.length },
		)

		expect(Arr.map(diff.patterns, (p) => p.change)).toEqual(["new", "new"])
		const [first, second] = diff.patterns
		expect(first?.template).toContain("payment failed")
		expect(first?.before.sampled).toBe(0)
		expect(first?.after.sampled).toBe(30)
		expect(first?.sample).toBe("payment failed for order 1: card declined")
		expect(second?.template).toContain("cache miss")
		expect(diff.unchanged).toBe(3)
	})

	it("reports nothing when traffic triples but the mix stays the same", () => {
		const before = steady(500)
		const after = steady(1500)
		const diff = diffLogPatterns(
			{ rows: before, total: before.length },
			{ rows: after, total: after.length },
		)
		expect(diff.patterns).toEqual([])
	})

	it("flags templates that disappeared or whose share moved, with the ratio", () => {
		const before = [
			...steady(1000),
			...repeat(100, (i) => `warmed cache shard ${i}`),
			...repeat(30, (i) => `retrying upstream call ${i}`),
		]
		const after = [...steady(1000), ...repeat(150, (i) => `retrying upstream call ${i}`)]
		const diff = diffLogPatterns(
			{ rows: before, total: before.length },
			{ rows: after, total: after.length },
		)

		const byChange = Rec.fromEntries(Arr.map(diff.patterns, (p) => [p.change, p]))
		expect(byChange.gone?.template).toContain("warmed cache shard")
		expect(byChange.gone?.ratio).toBeUndefined()
		expect(byChange.up?.template).toContain("retrying upstream call")
		expect(byChange.up?.ratio).toBeGreaterThan(4)
		// Emerging changes rank above faded ones.
		expect(Arr.map(diff.patterns, (p) => p.change)).toEqual(["up", "gone"])
	})

	it("ignores a small wobble that sampling alone explains", () => {
		const before = [...steady(1000), ...repeat(2, (i) => `slow query took ${i}s`)]
		const after = [...steady(1000), ...repeat(6, (i) => `slow query took ${i}s`)]
		const diff = diffLogPatterns(
			{ rows: before, total: before.length },
			{ rows: after, total: after.length },
		)
		expect(diff.patterns).toEqual([])
	})

	it("scales sample counts to the window's real log count", () => {
		const before = steady(1000)
		const after = [
			...steady(1000),
			...repeat(60, (i) => `payment failed for order ${i}: card declined`, "ERROR"),
		]
		const diff = diffLogPatterns({ rows: before, total: 30_000 }, { rows: after, total: 306_000 })
		const [pattern] = diff.patterns
		// 60 of 3060 sampled logs, scaled to 306k logs in the window.
		expect(pattern?.after.estimated).toBe(6000)
	})

	it("compares nothing when either window has no logs", () => {
		const after = repeat(50, (i) => `payment failed for order ${i}`, "ERROR")
		const diff = diffLogPatterns({ rows: [], total: 0 }, { rows: after, total: after.length })
		expect(diff.patterns).toEqual([])
		expect(diff.sampledBefore).toBe(0)
		expect(diff.sampledAfter).toBe(50)
	})

	it("caps the result at the limit", () => {
		const before = steady(500)
		const after = [
			...steady(500),
			...repeat(20, (i) => `alpha event ${i} happened`),
			...repeat(20, (i) => `beta thing ${i} broke badly today`),
		]
		const diff = diffLogPatterns(
			{ rows: before, total: before.length },
			{ rows: after, total: after.length },
			1,
		)
		expect(diff.patterns).toHaveLength(1)
	})
})

describe("hasErrorSeverity", () => {
	it("matches error levels in any SDK spelling", () => {
		expect(hasErrorSeverity({ error: 3 })).toBe(true)
		expect(hasErrorSeverity({ Fatal: 1 })).toBe(true)
		expect(hasErrorSeverity({ INFO: 9, WARN: 2 })).toBe(false)
	})
})
