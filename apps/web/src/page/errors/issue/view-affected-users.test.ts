import { describe, expect, it } from "vitest"
import { affectedUserHref, coverageOf } from "./view-affected-users"

describe("affected users coverage", () => {
	it("is the share of hits that named a user", () => {
		expect(coverageOf({ hits: 8, hitsWithUser: 6 })).toBe(0.75)
		expect(coverageOf({ hits: 5, hitsWithUser: 0 })).toBe(0)
	})

	it("has no value over a window without hits", () => {
		expect(coverageOf({ hits: 0, hitsWithUser: 0 })).toBeNull()
	})
})

describe("affected user links", () => {
	it("open the user page over the issue page's window", () => {
		expect(affectedUserHref("user/42", { timePreset: "24h", tab: "activity" })).toBe(
			"/users/user/42?timePreset=24h",
		)
	})
})
