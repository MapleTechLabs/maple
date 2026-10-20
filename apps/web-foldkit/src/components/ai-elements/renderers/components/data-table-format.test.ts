import { describe, expect, it } from "vitest"
import { formatCell, isIdentifierHeader } from "./data-table-format"

describe("formatCell", () => {
	it("groups plain quantities", () => {
		expect(formatCell("1234567", "count")).toBe((1234567).toLocaleString())
	})

	it("leaves UInt64 values past 2^53 untouched", () => {
		expect(formatCell("18446744073709551615", "value")).toBe("18446744073709551615")
	})

	it("leaves identifier-like columns untouched", () => {
		expect(formatCell("2026", "year")).toBe("2026")
		expect(formatCell("1312", "PR #")).toBe("1312")
		expect(formatCell("1312", "prNumber")).toBe("1312")
		expect(formatCell("123456", "trace_id")).toBe("123456")
	})

	it("leaves non-decimal strings and leading zeros alone", () => {
		expect(formatCell("0x10", "count")).toBe("0x10")
		expect(formatCell("007", "count")).toBe("007")
		expect(formatCell("", "count")).toBe("")
		expect(formatCell("1e5", "count")).toBe("1e5")
	})
})

describe("isIdentifierHeader", () => {
	it("does not flag quantity headers", () => {
		expect(isIdentifierHeader("count")).toBe(false)
		expect(isIdentifierHeader("p95 latency")).toBe(false)
		expect(isIdentifierHeader("spans")).toBe(false)
	})
})
