import { Array as Arr, Schema } from "effect"

// The board: pointy-top hexes in axial coordinates. One service's tile lies on one cell.

export const Cell = Schema.Struct({ q: Schema.Number, r: Schema.Number })
export type Cell = typeof Cell.Type

/** A point on the ground plane: world x and z. */
export type Point = readonly [number, number]

/** Centre to corner, in world units. Neighbouring centres are `HEX_SIZE * sqrt(3)` apart. */
export const HEX_SIZE = 4
export const NEIGHBOUR_DISTANCE = HEX_SIZE * Math.sqrt(3)

export const ORIGIN: Cell = { q: 0, r: 0 }

export const cellKey = (cell: Cell): string => `${cell.q},${cell.r}`

export const sameCell = (a: Cell, b: Cell): boolean => a.q === b.q && a.r === b.r

const DIRECTIONS: ReadonlyArray<Cell> = [
	{ q: 1, r: 0 },
	{ q: 1, r: -1 },
	{ q: 0, r: -1 },
	{ q: -1, r: 0 },
	{ q: -1, r: 1 },
	{ q: 0, r: 1 },
]

export const neighbours = (cell: Cell): ReadonlyArray<Cell> =>
	Arr.map(DIRECTIONS, (step) => ({ q: cell.q + step.q, r: cell.r + step.r }))

/** Steps between two cells; 1 means they share a side. */
export const hexDistance = (a: Cell, b: Cell): number => {
	const dq = a.q - b.q
	const dr = a.r - b.r
	return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2
}

export const cellToPoint = (cell: Cell): Point => [
	NEIGHBOUR_DISTANCE * (cell.q + cell.r / 2),
	HEX_SIZE * 1.5 * cell.r,
]

/** The cell a point on the ground falls in. */
export const pointToCell = ([x, z]: Point): Cell => {
	const r = z / (HEX_SIZE * 1.5)
	const q = x / NEIGHBOUR_DISTANCE - r / 2
	const s = -q - r
	const rounded = { q: Math.round(q), r: Math.round(r), s: Math.round(s) }
	const drift = {
		q: Math.abs(rounded.q - q),
		r: Math.abs(rounded.r - r),
		s: Math.abs(rounded.s - s),
	}
	// The three cube coordinates sum to zero: the one that rounded furthest is recomputed.
	if (drift.q > drift.r && drift.q > drift.s) return { q: -rounded.r - rounded.s, r: rounded.r }
	if (drift.r > drift.s) return { q: rounded.q, r: -rounded.q - rounded.s }
	return { q: rounded.q, r: rounded.r }
}

/** A cell's six corners, counter-clockwise from the lower right. */
export const corners = (cell: Cell): ReadonlyArray<Point> => {
	const [x, z] = cellToPoint(cell)
	return Arr.makeBy(6, (index) => {
		const angle = (Math.PI / 180) * (60 * index - 30)
		return [x + HEX_SIZE * Math.cos(angle), z + HEX_SIZE * Math.sin(angle)] as const
	})
}

/** Every cell within `radius` steps of `centre`. */
export const disc = (centre: Cell, radius: number): ReadonlyArray<Cell> =>
	Arr.flatMap(Arr.range(-radius, radius), (dq) =>
		Arr.map(Arr.range(Math.max(-radius, -dq - radius), Math.min(radius, -dq + radius)), (dr) => ({
			q: centre.q + dq,
			r: centre.r + dr,
		})),
	)
