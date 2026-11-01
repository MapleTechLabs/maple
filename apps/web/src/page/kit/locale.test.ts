import { describe, expect, it } from "vitest"
import { formatExactCount } from "./locale"

describe("formatExactCount", () => {
	it("keeps every digit where a cell would compact", () => {
		expect(formatExactCount(1_234_567)).toBe("1,234,567")
	})

	it("groups digits the way the page locale does", () => {
		expect(formatExactCount(12_480, "de-DE")).toBe("12.480")
	})
})
