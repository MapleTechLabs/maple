import { describe, expect, it } from "vitest"
import { nextTagSelection, noiseTierOf } from "./session-tags"

describe("nextTagSelection", () => {
	it("replaces the selected tier when another tier is ticked", () => {
		expect(nextTagSelection(["engaged"], ["engaged", "bounce"])).toEqual(["bounce"])
	})

	it("keeps traits alongside a newly ticked tier", () => {
		expect(nextTagSelection(["engaged", "signed_in"], ["engaged", "signed_in", "bot"])).toEqual([
			"signed_in",
			"bot",
		])
	})

	it("combines traits with each other and with the tier", () => {
		expect(nextTagSelection(["engaged"], ["engaged", "signed_in", "new_visitor"])).toEqual([
			"engaged",
			"signed_in",
			"new_visitor",
		])
	})

	it("unticks without touching the rest, and drops unknown values", () => {
		expect(nextTagSelection(["engaged", "signed_in"], ["signed_in", "frustrated"])).toEqual(["signed_in"])
	})
})

describe("noiseTierOf", () => {
	it("flags every tier but engaged, and ignores traits", () => {
		expect(noiseTierOf(["glance", "signed_in"])).toBe("glance")
		expect(noiseTierOf(["engaged", "new_visitor"])).toBeUndefined()
	})
})
