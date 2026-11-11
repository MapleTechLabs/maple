import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { cellToPoint, corners, disc, HEX_SIZE, hexDistance, neighbours, pointToCell } from "./hex"

describe("hex board", () => {
	it("finds the cell a point falls in, for every cell near the middle", () => {
		const cells = disc({ q: 0, r: 0 }, 4)
		expect(Arr.map(cells, (cell) => pointToCell(cellToPoint(cell)))).toEqual(cells)
	})

	it("keeps a point near a cell's edge inside that cell", () => {
		const [x, z] = cellToPoint({ q: 2, r: -3 })
		expect(pointToCell([x + HEX_SIZE * 0.8, z])).toEqual({ q: 2, r: -3 })
		expect(pointToCell([x + HEX_SIZE * 0.9, z])).toEqual({ q: 3, r: -3 })
	})

	it("gives a cell six neighbours, each one step away and all distinct", () => {
		const around = neighbours({ q: 1, r: 1 })
		expect(Arr.map(around, (cell) => hexDistance(cell, { q: 1, r: 1 }))).toEqual([1, 1, 1, 1, 1, 1])
		expect(new Set(Arr.map(around, (cell) => `${cell.q},${cell.r}`)).size).toBe(6)
	})

	it("shares each corner with the neighbours on either side of it", () => {
		const own = corners({ q: 0, r: 0 })
		const shared = Arr.map(
			neighbours({ q: 0, r: 0 }),
			(cell) =>
				Arr.filter(corners(cell), (corner) =>
					Arr.some(own, (point) => Math.hypot(point[0] - corner[0], point[1] - corner[1]) < 1e-6),
				).length,
		)
		expect(shared).toEqual([2, 2, 2, 2, 2, 2])
	})

	it("covers 1 + 3k(k + 1) cells within k steps", () => {
		expect(Arr.map([0, 1, 2, 3], (radius) => disc({ q: 5, r: -2 }, radius).length)).toEqual([
			1, 7, 19, 37,
		])
	})
})
