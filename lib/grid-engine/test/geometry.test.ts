import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { cellAt, columnWidth, itemRect, sizeAt, type GridGeometry, type GridItem } from "../src/index.ts"

// The canvas at 1200px: 12 columns of 89px with 12px gutters, 60px rows, and
// the vertical gap kept as top padding. Numbers worked by hand.
const desktop: GridGeometry = { width: 1200, cols: 12, rowHeight: 60, gap: [12, 12], padding: [0, 12] }

const item = (x: number, y: number, w: number, h: number, extra: Partial<GridItem> = {}): GridItem => ({
	i: "a",
	x,
	y,
	w,
	h,
	...extra,
})

describe("geometry", () => {
	it("splits the width into columns between gutters", () => {
		expect(columnWidth(desktop)).toBe(89)
	})

	it("places a tile by its cells", () => {
		expect(itemRect(desktop, item(0, 0, 1, 1))).toEqual({ left: 0, top: 12, width: 89, height: 60 })
		// Spans include the gutters they cross.
		expect(itemRect(desktop, item(3, 2, 6, 4))).toEqual({ left: 303, top: 156, width: 594, height: 276 })
	})

	it("snaps a dragged tile to the nearest cell and keeps it inside the grid", () => {
		const tile = item(0, 0, 3, 2)
		expect(cellAt(desktop, tile, 303 + 40, 156 + 30)).toEqual({ x: 3, y: 2 })
		expect(cellAt(desktop, tile, 303 + 60, 156 + 40)).toEqual({ x: 4, y: 3 })
		expect(cellAt(desktop, tile, -500, -500)).toEqual({ x: 0, y: 0 })
		// A 3-wide tile cannot start past column 9.
		expect(cellAt(desktop, tile, 5000, 0)).toEqual({ x: 9, y: 0 })
	})

	it("snaps a resized tile to whole cells within its limits", () => {
		const tile = item(6, 0, 2, 2, { minW: 2, minH: 2, maxH: 6 })
		expect(sizeAt(desktop, tile, 290, 200)).toEqual({ w: 3, h: 3 })
		expect(sizeAt(desktop, tile, 10, 10)).toEqual({ w: 2, h: 2 })
		// Width stops at the grid edge, height at the item's own max.
		expect(sizeAt(desktop, tile, 5000, 5000)).toEqual({ w: 6, h: 6 })
	})

	it("round-trips: a tile drawn at its cell maps back to that cell and size", () => {
		const geometryArb = fc.record({
			width: fc.integer({ min: 240, max: 2400 }),
			cols: fc.constantFrom(12, 8, 6, 1),
			gap: fc.constantFrom([12, 12] as const, [10, 10] as const, [8, 8] as const),
		})
		fc.assert(
			fc.property(
				geometryArb,
				fc.nat(),
				fc.integer({ min: 0, max: 50 }),
				fc.nat(),
				fc.integer({ min: 1, max: 10 }),
				(g, rawX, y, rawW, h) => {
					const geometry: GridGeometry = { ...g, rowHeight: 60, padding: [0, g.gap[1]] }
					const w = (rawW % g.cols) + 1
					const x = rawX % (g.cols - w + 1)
					const tile = item(x, y, w, h)
					const rect = itemRect(geometry, tile)
					expect(cellAt(geometry, tile, rect.left, rect.top)).toEqual({ x, y })
					expect(sizeAt(geometry, tile, rect.width, rect.height)).toEqual({ w, h })
				},
			),
			{ numRuns: 5000 },
		)
	})
})
