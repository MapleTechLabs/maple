import { describe, expect, it } from "vitest"
import { tooltipFormatOf } from "./tool-series"

describe("tool series tooltip", () => {
	it("reads a whole count exactly, not compacted", () => {
		const text = tooltipFormatOf("number")(12_480)
		expect(text).not.toContain("K")
		expect(text.replace(/\D/g, "")).toBe("12480")
		expect(tooltipFormatOf("calls")(1_234_567).replace(/\D/g, "")).toBe("1234567")
	})

	it("keeps the decimals of a fractional value", () => {
		expect(tooltipFormatOf("number")(0.4)).toBe("0.4")
	})

	it("keeps the unit formatter for durations and rates", () => {
		expect(tooltipFormatOf("durationNs")(2_000_000_000)).toBe("2.00s")
		expect(tooltipFormatOf("errorRate")(0.05)).toBe("5.0%")
	})
})
