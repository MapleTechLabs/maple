import { describe, expect, test } from "vitest"
import { miniBarsLayout } from "./mini-bars"

const lastBarEnd = (count: number, gap: number): number => {
	const layout = miniBarsLayout(count, gap)
	return (count - 1) * (layout.barWidth + layout.gap) + layout.barWidth
}

describe("miniBars layout", () => {
	test("a week of hourly buckets fits the box: the newest bar ends at its right edge", () => {
		expect(lastBarEnd(169, 2)).toBeCloseTo(100)
		expect(miniBarsLayout(169, 2).barWidth).toBeGreaterThan(0)
	})

	test("a few bars keep the requested gap", () => {
		expect(miniBarsLayout(12, 2).gap).toBe(2)
		expect(lastBarEnd(12, 2)).toBeCloseTo(100)
	})
})
