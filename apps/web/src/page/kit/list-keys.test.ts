import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { focusedIndexOf, listKeyAction, listStepOf, steppedFocus } from "./list-keys"

describe("steppedFocus", () => {
	test("no focus goes to the first row in either direction", () => {
		expect(steppedFocus(null, 1, 3)).toBe(0)
		expect(steppedFocus(null, -1, 3)).toBe(0)
	})

	test("a step moves one row and holds at both ends", () => {
		expect(steppedFocus(0, 1, 3)).toBe(1)
		expect(steppedFocus(2, 1, 3)).toBe(2)
		expect(steppedFocus(1, -1, 3)).toBe(0)
		expect(steppedFocus(0, -1, 3)).toBe(0)
	})

	test("a focus past a shrunken list comes back to its last row", () => {
		expect(steppedFocus(9, 1, 3)).toBe(2)
		expect(steppedFocus(9, -1, 3)).toBe(2)
	})

	test("an empty list keeps what it had", () => {
		expect(steppedFocus(null, 1, 0)).toBeNull()
		expect(steppedFocus(4, -1, 0)).toBe(4)
	})
})

describe("listStepOf", () => {
	test("J and the down arrow step forward, K and the up arrow back, anything else not at all", () => {
		expect(Arr.map(["j", "J", "ArrowDown"], listStepOf)).toEqual([1, 1, 1])
		expect(Arr.map(["k", "K", "ArrowUp"], listStepOf)).toEqual([-1, -1, -1])
		expect(Arr.map(["Enter", "Escape", "x"], listStepOf)).toEqual([null, null, null])
	})
})

describe("listKeyAction", () => {
	test("a step key moves the focus, and does nothing over no rows", () => {
		expect(listKeyAction("j", null, 2)).toEqual({ _tag: "Focus", index: 0 })
		expect(listKeyAction("ArrowDown", 0, 2)).toEqual({ _tag: "Focus", index: 1 })
		expect(listKeyAction("k", 1, 2)).toEqual({ _tag: "Focus", index: 0 })
		expect(listKeyAction("j", null, 0)).toEqual({ _tag: "None" })
	})

	test("Enter opens the focused row, and nothing without one or past the rows", () => {
		expect(listKeyAction("Enter", 1, 2)).toEqual({ _tag: "Open", index: 1 })
		expect(listKeyAction("Enter", null, 2)).toEqual({ _tag: "None" })
		expect(listKeyAction("Enter", 5, 2)).toEqual({ _tag: "None" })
	})

	test("Escape clears the focus", () => {
		expect(listKeyAction("Escape", 1, 2)).toEqual({ _tag: "Focus", index: null })
	})
})

describe("focusedIndexOf", () => {
	test("the focused id's place among the rows now, none once it left", () => {
		expect(focusedIndexOf(["a", "b", "c"], "c")).toBe(2)
		expect(focusedIndexOf(["c", "a"], "c")).toBe(0)
		expect(focusedIndexOf(["a", "b"], "gone")).toBeNull()
		expect(focusedIndexOf(["a", "b"], null)).toBeNull()
	})
})
