import { describe, expect, it } from "vitest"

import { medianOf, nonZeroOr } from "./number"

describe("nonZeroOr", () => {
	it("keeps any non-zero number, negatives included", () => {
		expect(nonZeroOr(2.5, 1)).toBe(2.5)
		expect(nonZeroOr(-3, 1)).toBe(-3)
	})

	it("falls back for 0, -0 and NaN", () => {
		expect(nonZeroOr(0, 1)).toBe(1)
		expect(nonZeroOr(-0, 1)).toBe(1)
		expect(nonZeroOr(Number.parseFloat("auto"), 10)).toBe(10)
	})
})

describe("medianOf", () => {
	it("takes the middle value, the mean of the middle two, or null with none", () => {
		expect([medianOf([5, 1, 3]), medianOf([4, 1, 3, 2]), medianOf([])]).toEqual([3, 2.5, null])
	})
})
