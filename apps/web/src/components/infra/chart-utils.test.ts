import { describe, expect, it } from "vitest"
import { formatSeconds, formatValueWithUnit } from "./chart-utils"

describe("formatValueWithUnit", () => {
	it("renders a percentage with a % sign", () => {
		expect(formatValueWithUnit(0.095, "percent")).toBe("9.5%")
		expect(formatValueWithUnit(0.5, "percent")).toBe("50%")
	})

	it("renders cores with a unit suffix (never a bare number)", () => {
		expect(formatValueWithUnit(0.067, "cores")).toBe("0.067 cores")
		expect(formatValueWithUnit(2, "cores")).toBe("2 cores")
	})

	it("renders a duration for seconds", () => {
		expect(formatValueWithUnit(45, "seconds")).toBe("45s")
		expect(formatValueWithUnit(3600, "seconds")).toBe("1h 0m")
	})

	it("renders load as a fixed-precision number", () => {
		expect(formatValueWithUnit(1.2, "load")).toBe("1.20")
	})

	it("renders bytes/second with a rate unit", () => {
		expect(formatValueWithUnit(2048, "bytes_per_second")).toBe("2.0 KB/s")
	})

	it("guards against non-finite values", () => {
		expect(formatValueWithUnit(Number.NaN, "cores")).toBe("—")
		expect(formatValueWithUnit(Number.POSITIVE_INFINITY, "percent")).toBe("—")
	})
})

describe("formatSeconds", () => {
	it("scales the unit with magnitude", () => {
		expect(formatSeconds(30)).toBe("30s")
		expect(formatSeconds(120)).toBe("2m")
		expect(formatSeconds(3 * 3600 + 20 * 60)).toBe("3h 20m")
		expect(formatSeconds(2 * 86400 + 4 * 3600)).toBe("2d 4h")
	})

	it("returns an em dash for non-positive/invalid input", () => {
		expect(formatSeconds(0)).toBe("—")
		expect(formatSeconds(-5)).toBe("—")
	})
})
