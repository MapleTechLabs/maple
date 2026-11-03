import { describe, expect, it } from "vitest"
import { formatPercent } from "./format"

describe("formatPercent", () => {
	it("prints an exact two-decimal uptime that float error puts just below it", () => {
		// 624 of 625 checks up: 99.84, which `* 100` makes 9983.999999999999.
		expect(formatPercent((624 / 625) * 100)).toBe("99.84%")
	})

	it("still floors real downtime, so it never rounds up to 100%", () => {
		expect(formatPercent(99.999)).toBe("99.99%")
		expect(formatPercent(100)).toBe("100%")
	})
})
