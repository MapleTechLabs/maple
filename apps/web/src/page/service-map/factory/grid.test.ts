import { describe, expect, test } from "vitest"
import { MODULE } from "../three/machines"
import { spatialLayout } from "../three/spatial-layout"
import { BUILDING_TYPES, BUILDINGS } from "./catalog"
import { CELL_SIZE, cellToScene, sceneToCell } from "./grid"

describe("grid", () => {
	test("machines the atlas lays out in one district stand a whole number of cells apart", () => {
		const nodes = Array.from({ length: 4 }, (_, i) => ({ id: `svc-${i}`, namespace: "team" }))
		const [first, ...rest] = [...spatialLayout({ nodes, edges: [] }, "atlas").positions.values()]
		if (first === undefined) return expect.unreachable("no positions")
		expect(rest).toHaveLength(3)
		for (const position of rest)
			for (const axis of [0, 2] as const) {
				const cells = (position[axis] - first[axis]) / CELL_SIZE
				expect(Math.abs(cells - Math.round(cells))).toBeLessThan(1e-9)
			}
	})

	test("every building's footprint covers a two-module machine", () => {
		for (const type of BUILDING_TYPES) {
			const { width, depth } = BUILDINGS[type].footprint
			expect(Math.min(width, depth) * CELL_SIZE).toBeGreaterThanOrEqual(2 * MODULE)
		}
	})

	test("a cell round-trips through scene space", () => {
		const cell = { x: -7, z: 12 }
		expect(sceneToCell(cellToScene(cell))).toEqual(cell)
	})

	test("scene points snap to the nearest cell centre", () => {
		expect(sceneToCell([CELL_SIZE * 2.4, 3, -CELL_SIZE * 0.6])).toEqual({ x: 2, z: -1 })
		expect(sceneToCell([CELL_SIZE * 0.49, 0, -CELL_SIZE * 0.49])).toEqual({ x: 0, z: 0 })
	})

	test("snapping never yields negative zero, so keys are stable", () => {
		const cell = sceneToCell([-0.01, 0, -0.01])
		expect([Object.is(cell.x, -0), Object.is(cell.z, -0)]).toEqual([false, false])
	})

	test("cellToScene keeps the requested height", () => {
		expect(cellToScene({ x: 1, z: 0 }, 0.75)[1]).toBe(0.75)
	})
})
