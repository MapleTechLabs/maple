import { describe, expect, it } from "vitest"
import { formatUsageAgainst } from "./usage"

describe("formatUsageAgainst", () => {
	it("reads zero and near-zero usage in the allotment's unit, so quiet features match", () => {
		expect(formatUsageAgainst(0, 100)).toBe("0.00 GB of 100.00 GB")
		expect(formatUsageAgainst(0.000_001, 100)).toBe("<0.01 GB of 100.00 GB")
		expect(formatUsageAgainst(0.25, 100)).toBe("0.25 GB of 100.00 GB")
	})

	it("switches both sides together when usage outgrows the allotment's unit", () => {
		expect(formatUsageAgainst(164, 100)).toBe("164.00 GB of 100.00 GB")
		expect(formatUsageAgainst(12_500, 100)).toBe("12.50 TB of 0.10 TB")
	})

	it("treats an unreadable usage as zero", () => {
		expect(formatUsageAgainst(Number.NaN, 100)).toBe("0.00 GB of 100.00 GB")
	})
})
