import { describe, expect, test } from "vitest"
import { CARD_ROW_HEIGHT, visibleRows } from "./derive"

const viewport = (scrollTop: number, height: number) => ({ width: 1200, height, scrollTop })

describe("metrics grid row window", () => {
	test("before the scroller is measured, the first row and its overscan are drawn", () => {
		expect(visibleRows(100, viewport(0, 0))).toEqual([0, 1, 2, 3, 4])
	})

	test("scrolled into the middle, the rows in view plus four either side are drawn", () => {
		expect(visibleRows(100, viewport(20 * CARD_ROW_HEIGHT, 3 * CARD_ROW_HEIGHT))).toEqual([
			16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
		])
	})

	test("the window stops at the last row, and an empty grid draws nothing", () => {
		expect(visibleRows(10, viewport(9 * CARD_ROW_HEIGHT, 5 * CARD_ROW_HEIGHT))).toEqual([5, 6, 7, 8, 9])
		expect(visibleRows(0, viewport(0, 800))).toEqual([])
	})
})
