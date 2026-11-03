import { describe, expect, test } from "vitest"
import { contributionLevel } from "./contribution-calendar"

describe("contributionLevel", () => {
	test("any activity is at least the first level, the busiest day the last", () => {
		expect(contributionLevel(0, 10)).toBe(0)
		expect(contributionLevel(1, 40)).toBe(1)
		expect(contributionLevel(5, 10)).toBe(2)
		expect(contributionLevel(10, 10)).toBe(4)
	})
})
