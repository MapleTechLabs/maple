import { describe, expect, it } from "vitest"
import { parseWarehouseDateTime, warehouseDateTimeToIso } from "./datetime"

describe("warehouseDateTimeToIso", () => {
	it("appends Z to a tz-less space-separated DateTime", () => {
		expect(warehouseDateTimeToIso("2026-05-24 14:30:00")).toBe("2026-05-24T14:30:00Z")
	})

	it("appends Z to a tz-less T-separated DateTime", () => {
		expect(warehouseDateTimeToIso("2026-05-24T14:30:00")).toBe("2026-05-24T14:30:00Z")
	})

	it("normalizes fractional seconds to milliseconds with Z", () => {
		expect(warehouseDateTimeToIso("2026-05-24 14:30:00.123456")).toBe("2026-05-24T14:30:00.123Z")
		expect(warehouseDateTimeToIso("2026-05-24 14:30:00.5")).toBe("2026-05-24T14:30:00.500Z")
	})

	it("passes through strings that already carry a Z", () => {
		expect(warehouseDateTimeToIso("2026-05-24T14:30:00Z")).toBe("2026-05-24T14:30:00Z")
	})

	it("passes through strings with a numeric offset", () => {
		expect(warehouseDateTimeToIso("2026-05-24T14:30:00+02:00")).toBe("2026-05-24T14:30:00+02:00")
	})

	it("trims surrounding whitespace", () => {
		expect(warehouseDateTimeToIso("  2026-05-24 14:30:00  ")).toBe("2026-05-24T14:30:00Z")
	})

	it("returns non-timestamp input unchanged (trimmed)", () => {
		expect(warehouseDateTimeToIso(" not-a-date ")).toBe("not-a-date")
	})
})

describe("parseWarehouseDateTime", () => {
	it("parses a tz-less DateTime as UTC", () => {
		expect(parseWarehouseDateTime("2026-05-24 14:30:00")).toBe(Date.UTC(2026, 4, 24, 14, 30, 0))
	})

	it("is independent of the process timezone", () => {
		// The numeric epoch must equal the UTC instant regardless of TZ. We can't
		// re-set process.env.TZ mid-run reliably, so assert against the UTC constant
		// which is timezone-independent by construction.
		const expected = Date.UTC(2026, 0, 1, 0, 0, 0)
		expect(parseWarehouseDateTime("2026-01-01 00:00:00")).toBe(expected)
	})

	it("returns NaN for unparseable input", () => {
		expect(Number.isNaN(parseWarehouseDateTime("nonsense"))).toBe(true)
	})
})
