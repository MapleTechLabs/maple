import { describe, expect, it } from "vitest"

import { getSeriesColorByIndex, getSemanticSeriesColor, resolveSeriesColor } from "../semantic-series-colors"

describe("getSeriesColorByIndex", () => {
	it("uses the named --chart vars for the first five series", () => {
		expect(getSeriesColorByIndex(0)).toBe("var(--chart-1)")
		expect(getSeriesColorByIndex(4)).toBe("var(--chart-5)")
	})

	it("synthesizes distinct OKLCH colors beyond the named palette", () => {
		const colors = Array.from({ length: 60 }, (_, i) => getSeriesColorByIndex(i))
		// Every index yields a non-empty color string.
		expect(colors.every((c) => typeof c === "string" && c.length > 0)).toBe(true)
		// Generated colors (index >= 5) are unique — no wrap-around collisions.
		const generated = colors.slice(5)
		expect(new Set(generated).size).toBe(generated.length)
		expect(generated[0].startsWith("oklch(")).toBe(true)
	})

	it("clamps negative / fractional indices", () => {
		expect(getSeriesColorByIndex(-3)).toBe("var(--chart-1)")
		expect(getSeriesColorByIndex(2.7)).toBe("var(--chart-3)")
	})
})

describe("resolveSeriesColor", () => {
	it("prefers a semantic color when the name matches a known pattern", () => {
		// "error" maps to the error severity var regardless of index.
		expect(resolveSeriesColor("error", 7)).toBe(getSemanticSeriesColor("error"))
	})

	it("falls back to the per-index color for unknown names", () => {
		expect(resolveSeriesColor("checkout-service", 0)).toBe("var(--chart-1)")
		expect(resolveSeriesColor("checkout-service", 9)).toBe(getSeriesColorByIndex(9))
	})
})
