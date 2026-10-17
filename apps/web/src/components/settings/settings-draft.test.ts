import { describe, expect, it } from "vitest"
import { isSameDraft } from "./settings-draft"

describe("isSameDraft", () => {
	it("compares nested plain data by value, ignoring key order", () => {
		expect(isSameDraft({ a: 1, b: { c: ["x", "y"] } }, { b: { c: ["x", "y"] }, a: 1 })).toBe(true)
	})

	it("sees a changed nested value or array order as a change", () => {
		expect(isSameDraft({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false)
		expect(isSameDraft(["x", "y"], ["y", "x"])).toBe(false)
		expect(isSameDraft([1], [1, 2])).toBe(false)
	})

	it("treats a key holding undefined like a missing key", () => {
		expect(isSameDraft({ a: 1, note: undefined }, { a: 1 })).toBe(true)
	})

	it("does not equate values of different shapes", () => {
		expect(isSameDraft({ 0: "a" }, ["a"])).toBe(false)
		expect(isSameDraft(null, {})).toBe(false)
		expect(isSameDraft("1", 1)).toBe(false)
	})

	it("treats NaN as equal to itself so an untouched numeric field is clean", () => {
		expect(isSameDraft({ n: Number.NaN }, { n: Number.NaN })).toBe(true)
	})
})
