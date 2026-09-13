import { describe, expect, it } from "vitest"
import { formatDelta, formatPointsDelta, tableCell } from "./format"

describe("formatDelta", () => {
	it("reports a change against a window that measured something", () => {
		expect(formatDelta(120, 100)).toBe("+20.0%")
		expect(formatDelta(50, 100)).toBe("-50.0%")
	})

	it("reports appearing from nothing as +inf", () => {
		expect(formatDelta(5, 0)).toBe("+inf")
	})

	it("reports nothing against nothing as no comparison", () => {
		expect(formatDelta(0, 0)).toBe("—")
	})
})

describe("formatPointsDelta", () => {
	it("reports a change between two rates in points, not as a rate of rates", () => {
		expect(formatPointsDelta(0.05, 0.02)).toBe("+3.00 pp")
		expect(formatPointsDelta(0.02, 0.05)).toBe("-3.00 pp")
	})
})

describe("tableCell", () => {
	it("collapses a payload's newlines into one line", () => {
		expect(tableCell("first\n second\tthird ")).toBe("first second third")
	})

	it("escapes a pipe, which would otherwise shift every column after it", () => {
		expect(tableCell("a | b")).toBe("a \\| b")
	})

	it("escapes a backslash too, so one before a pipe cannot un-escape it", () => {
		expect(tableCell("a\\|b")).toBe("a\\\\\\|b")
	})

	it("clips before escaping, so a cut cannot leave a trailing backslash", () => {
		expect(tableCell("|".repeat(20), 10)).toBe("\\|\\|\\|\\|\\|\\|\\|...")
	})

	it("keeps text within the ceiling whole", () => {
		expect(tableCell("short", 40)).toBe("short")
	})
})
