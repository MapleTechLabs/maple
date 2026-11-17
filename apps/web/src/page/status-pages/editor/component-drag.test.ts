import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { dropIndex, landingOffset, shiftOf } from "./component-drag"

// Three rows, the middle one opened in place: 40, 120 and 40 pixels tall.
const SPANS = [
	{ top: 0, height: 40 },
	{ top: 40, height: 120 },
	{ top: 160, height: 40 },
]

describe("dropIndex", () => {
	test("held short of halfway to the next slot, a row keeps its own", () => {
		expect(dropIndex(SPANS, 0, 59)).toBe(0)
		expect(dropIndex(SPANS, 2, -59)).toBe(2)
	})

	test("past halfway it takes the next slot, however tall the row it passes", () => {
		expect(dropIndex(SPANS, 0, 61)).toBe(1)
		expect(dropIndex(SPANS, 0, 141)).toBe(2)
		expect(dropIndex(SPANS, 2, -61)).toBe(1)
		expect(dropIndex(SPANS, 2, -141)).toBe(0)
	})

	test("held as far as its group allows, it takes the end slot even beside a shorter row", () => {
		const rows = [
			{ top: 0, height: 44 },
			{ top: 44, height: 45 },
		]
		expect(dropIndex(rows, 1, -44)).toBe(0)
		expect(dropIndex(rows, 0, 45)).toBe(1)
	})
})

describe("shiftOf", () => {
	test("the rows between the slot it left and the one it is over make room by its height", () => {
		expect(Arr.map([0, 1, 2], (index) => shiftOf(index, 0, 2, 40))).toEqual([0, -40, -40])
		expect(Arr.map([0, 1, 2], (index) => shiftOf(index, 2, 1, 40))).toEqual([0, 40, 0])
	})

	test("over its own slot nothing moves", () => {
		expect(Arr.map([0, 1, 2], (index) => shiftOf(index, 1, 1, 120))).toEqual([0, 0, 0])
	})
})

describe("landingOffset", () => {
	test("moving down, its bottom meets the bottom of the row it passed", () => {
		expect(landingOffset(SPANS, 0, 1)).toBe(120)
		expect(landingOffset(SPANS, 0, 2)).toBe(160)
	})

	test("moving up, its top meets the top of the row it passed", () => {
		expect(landingOffset(SPANS, 2, 0)).toBe(-160)
		expect(landingOffset(SPANS, 1, 0)).toBe(-40)
	})

	test("over its own slot it rests where it was", () => {
		expect(landingOffset(SPANS, 1, 1)).toBe(0)
	})
})
