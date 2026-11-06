import { describe, expect, it } from "vitest"
import { CHART_BG_CLASSES, getDepthColorClass } from "../colors"

describe("getDepthColorClass", () => {
	const period = CHART_BG_CLASSES.length

	it("cycles through the palette as depth grows", () => {
		expect(getDepthColorClass(period)).toBe(getDepthColorClass(0))
		expect(getDepthColorClass(period + 2)).toBe(getDepthColorClass(2))
	})

	it("wraps a negative depth onto the palette instead of returning undefined", () => {
		expect(getDepthColorClass(-1)).toBe(getDepthColorClass(period - 1))
		expect(getDepthColorClass(-period)).toBe(getDepthColorClass(0))
	})
})
