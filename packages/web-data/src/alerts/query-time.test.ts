import { describe, expect, it } from "vitest"
import { formatQuerySeconds } from "./query-time"

describe("formatQuerySeconds", () => {
	it("reads like a person would say it", () => {
		expect(formatQuerySeconds(20)).toBe("under 0.1 s")
		expect(formatQuerySeconds(120)).toBe("0.1 s")
		expect(formatQuerySeconds(7_800)).toBe("7.8 s")
		expect(formatQuerySeconds(5_000)).toBe("5 s")
		expect(formatQuerySeconds(15_400)).toBe("15 s")
	})
})
