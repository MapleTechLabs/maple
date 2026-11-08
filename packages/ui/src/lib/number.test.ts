import { describe, expect, it } from "vitest"

import { nonZeroOr } from "./number"

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
