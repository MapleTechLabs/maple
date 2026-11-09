import type { WorldCell } from "@maple/domain/http"
import type { Vec3 } from "../../../components/service-map/three/types"

// The factory floor's snapping grid. A cell is centred on its lattice point: cell (x, z) covers
// scene [(x - 0.5) * CELL_SIZE, (x + 0.5) * CELL_SIZE) on each axis.

/** 0.7 units: the atlas spacing (4.2) is 6 cells and a 1.6-wide machine fits a 3x3 footprint. */
export const CELL_SIZE = 0.7

/** A cell's centre on the ground plane (`y` defaults to 0). */
export const cellToScene = (cell: WorldCell, y = 0): Vec3 => [cell.x * CELL_SIZE, y, cell.z * CELL_SIZE]

/** The cell a scene point falls in (snap to the nearest lattice point). */
export const sceneToCell = (position: Vec3): WorldCell => ({
	x: snap(position[0]),
	z: snap(position[2]),
})

// `Math.round` biases .5 upward; adding 0 turns -0 into 0 so keys stay stable.
const snap = (value: number) => Math.round(value / CELL_SIZE) + 0

export type CellKey = string

export const cellKey = (cell: WorldCell): CellKey => `${cell.x},${cell.z}`

export const sameCell = (a: WorldCell, b: WorldCell) => a.x === b.x && a.z === b.z
