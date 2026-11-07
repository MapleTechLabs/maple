import { describe, expect, test } from "vitest"
import { CELL_SIZE, cellToScene, sceneToCell } from "./grid"

describe("grid", () => {
	test("the atlas spacing and a machine footprint land on whole cells", () => {
		expect(Number.isInteger(Math.round((4.2 / CELL_SIZE) * 1e9) / 1e9)).toBe(true)
		expect(3 * CELL_SIZE).toBeGreaterThanOrEqual(1.6)
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
