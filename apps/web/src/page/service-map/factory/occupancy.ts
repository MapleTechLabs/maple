import type { BuildingType, WorldCell, WorldRotation } from "@maple/domain/http"
import { Array as Arr, Option, Order } from "effect"
import { BUILDINGS, type Footprint } from "./catalog"
import { type CellKey, cellKey } from "./grid"

// Which cells each building covers. A footprint sits on its anchor cell, centred for odd
// sizes and leaning to -x/-z for even ones; a quarter turn swaps width and depth.

/** Owner (node id) per occupied cell. */
export type Occupancy = ReadonlyMap<CellKey, string>

/** The slice of a resolved world occupancy queries need. */
export interface OccupancyWorld {
	readonly occupancy: Occupancy
	readonly buildings: ReadonlyMap<string, BuildingType>
	readonly rotations: ReadonlyMap<string, WorldRotation>
}

export const rotatedFootprint = (footprint: Footprint, rotation: WorldRotation): Footprint =>
	rotation === 90 || rotation === 270 ? { width: footprint.depth, depth: footprint.width } : footprint

const span = (anchor: number, size: number) =>
	Arr.makeBy(Math.max(1, size), (i) => anchor - Math.floor((size - 1) / 2) + i)

export const footprintCells = (
	cell: WorldCell,
	footprint: Footprint,
	rotation: WorldRotation = 0,
): ReadonlyArray<WorldCell> => {
	const { width, depth } = rotatedFootprint(footprint, rotation)
	return Arr.flatMap(span(cell.z, depth), (z) => Arr.map(span(cell.x, width), (x) => ({ x, z })))
}

export const buildingCells = (cell: WorldCell, building: BuildingType, rotation: WorldRotation = 0) =>
	footprintCells(cell, BUILDINGS[building].footprint, rotation)

/** `occupancy` plus `owner` on `cells` (later owners win; resolve never overlaps placed ones). */
export const occupy = (occupancy: Occupancy, owner: string, cells: ReadonlyArray<WorldCell>): Occupancy => {
	const next = new Map(occupancy)
	Arr.forEach(cells, (cell) => next.set(cellKey(cell), owner))
	return next
}

/** True when every cell is free or already `owner`'s. */
export const cellsFree = (occupancy: Occupancy, owner: string, cells: ReadonlyArray<WorldCell>) =>
	Arr.every(cells, (cell) => {
		const holder = occupancy.get(cellKey(cell))
		return holder === undefined || holder === owner
	})

/** Whether `nodeId`'s building (current type and rotation) fits at `cell`. */
export const canPlace = (world: OccupancyWorld, nodeId: string, cell: WorldCell): boolean => {
	const building = world.buildings.get(nodeId)
	if (building === undefined) return false
	return cellsFree(world.occupancy, nodeId, buildingCells(cell, building, world.rotations.get(nodeId) ?? 0))
}

/** Rings searched before giving up: a 129x129-cell square around the start. */
const MAX_RING = 64

const ringOrder = Order.combine(
	Order.mapInput(Order.Number, (cell: WorldCell & { readonly d: number }) => cell.d),
	Order.combine(
		Order.mapInput(Order.Number, (cell: WorldCell) => cell.z),
		Order.mapInput(Order.Number, (cell: WorldCell) => cell.x),
	),
)

/** The cells `ring` steps (Chebyshev) from `from`, nearest (Euclidean) first, ties by z then x. */
const ring = (from: WorldCell, radius: number): ReadonlyArray<WorldCell> => {
	if (radius === 0) return [from]
	const side = Arr.makeBy(radius * 2 + 1, (i) => i - radius)
	const cells = Arr.flatMap(side, (dz) =>
		Arr.flatMap(side, (dx) =>
			Math.max(Math.abs(dx), Math.abs(dz)) === radius
				? [{ x: from.x + dx, z: from.z + dz, d: dx * dx + dz * dz }]
				: [],
		),
	)
	return Arr.map(Arr.sort(cells, ringOrder), ({ x, z }) => ({ x, z }))
}

/** The closest anchor cell (ring by ring outward from `from`) where `footprint` fits for
 * `owner`; deterministic. None when nothing fits within `MAX_RING`. */
export const nearestFreeCell = (
	occupancy: Occupancy,
	owner: string,
	from: WorldCell,
	footprint: Footprint,
	rotation: WorldRotation = 0,
): Option.Option<WorldCell> =>
	Arr.findFirst(
		Arr.makeBy(MAX_RING + 1, (radius) => radius),
		(radius) =>
			Arr.findFirst(ring(from, radius), (cell) =>
				cellsFree(occupancy, owner, footprintCells(cell, footprint, rotation)),
			),
	)
