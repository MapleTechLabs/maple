import { describe, expect, it } from "vitest"
import { formatSpan } from "./code-review-format"

describe("formatSpan", () => {
	it("moves to the next unit when rounding reaches its boundary", () => {
		expect(formatSpan(59.4)).toBe("59s")
		expect(formatSpan(59.6)).toBe("1m")
		expect(formatSpan(3_590)).toBe("1.0h")
		expect(formatSpan(86_300)).toBe("1.0d")
	})
})
