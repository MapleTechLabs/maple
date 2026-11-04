import { describe, expect, it } from "vitest"
import { coverageOf } from "./view-affected-users"

describe("affected users coverage", () => {
	it("is the share of hits that named a user", () => {
		expect(coverageOf({ hits: 8, hitsWithUser: 6 })).toBe(0.75)
		expect(coverageOf({ hits: 5, hitsWithUser: 0 })).toBe(0)
	})

	it("has no value over a window without hits", () => {
		expect(coverageOf({ hits: 0, hitsWithUser: 0 })).toBeNull()
	})
})
