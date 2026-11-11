import { describe, expect, it } from "vitest"
import { formatDuration, formatPercent } from "./format"

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

describe("formatDuration", () => {
	it("reads in the largest two units, dropping a zero remainder", () => {
		expect(formatDuration(30_000)).toBe("under 1 min")
		expect(formatDuration(45 * 60_000)).toBe("45 min")
		expect(formatDuration(75 * 60_000)).toBe("1 h 15 min")
		expect(formatDuration(2 * 3_600_000)).toBe("2 h")
		expect(formatDuration(51 * 3_600_000)).toBe("2 d 3 h")
		expect(formatDuration(48 * 3_600_000)).toBe("2 d")
	})
})
