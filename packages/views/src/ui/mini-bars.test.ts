import { describe, expect, test } from "vitest"
import { miniBarsLayout, miniBarsRatio } from "./mini-bars"

describe("miniBars layout", () => {
	test("a week of hourly buckets fits the box: the gap shrinks to half a slot", () => {
		const { barWidth, gap } = miniBarsLayout(169, 2)
		expect(gap).toBeCloseTo(50 / 169)
		expect(barWidth).toBeCloseTo((100 - (50 / 169) * 168) / 169)
		expect(barWidth).toBeGreaterThan(0)
	})

	test("a few bars keep the requested gap", () => {
		expect(miniBarsLayout(12, 2)).toEqual({ barWidth: 6.5, gap: 2 })
	})

	test("with a max of 1 a ratio is the bar's height, and nothing draws past the top", () => {
		expect(miniBarsRatio(0.25, 1)).toBe(0.25)
		expect(miniBarsRatio(1.5, 1)).toBe(1)
		expect(miniBarsRatio(3, 0)).toBe(0)
	})
})
