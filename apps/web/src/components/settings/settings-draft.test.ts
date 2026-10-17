import { describe, expect, it } from "vitest"
import { commitEdits, divergesFromSave, isSameDraft, isSaveSettled } from "./settings-draft"

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

describe("commitEdits", () => {
	it("settles the edits the save submitted, recording what it sent", () => {
		expect(
			commitEdits(
				{ value: { rate: 25.5 } },
				{ submitted: { rate: 25.5 }, sent: { rate: 25 } },
				{ rate: 10 },
				isSameDraft,
			),
		).toEqual({ value: { rate: 25.5 }, committedOver: { saved: { rate: 10 }, sent: { rate: 25 } } })
	})

	it("leaves an edit made after the save started uncommitted", () => {
		expect(
			commitEdits({ value: { rate: 60 } }, { submitted: { rate: 50 } }, { rate: 10 }, isSameDraft),
		).toEqual({
			value: { rate: 60 },
		})
	})

	it("has nothing to settle when the edits were already dropped", () => {
		expect(commitEdits(null, { submitted: { rate: 50 } }, { rate: 10 }, isSameDraft)).toBeNull()
	})
})

describe("in-flight save", () => {
	const save = { submitted: { rate: 50 }, base: { rate: 10 } }

	it("counts a revert to the saved value as unsaved while the save will store something else", () => {
		expect(divergesFromSave({ rate: 10 }, save, isSameDraft)).toBe(true)
		expect(divergesFromSave({ rate: 50 }, save, isSameDraft)).toBe(false)
	})

	it("accepts either the submitted or the normalized sent value as matching", () => {
		const normalized = { submitted: { rate: 25.5 }, sent: { rate: 25 } }
		expect(divergesFromSave({ rate: 25.5 }, normalized, isSameDraft)).toBe(false)
		expect(divergesFromSave({ rate: 25 }, normalized, isSameDraft)).toBe(false)
		expect(divergesFromSave({ rate: 10 }, normalized, isSameDraft)).toBe(true)
	})

	it("settles once the saved value moves off the base or reaches the stored value", () => {
		expect(isSaveSettled(save, { rate: 10 }, isSameDraft)).toBe(false)
		expect(isSaveSettled(save, { rate: 50 }, isSameDraft)).toBe(true)
		expect(isSaveSettled(save, { rate: 70 }, isSameDraft)).toBe(true)
		expect(isSaveSettled({ ...save, sent: { rate: 25 } }, { rate: 25 }, isSameDraft)).toBe(true)
	})
})
