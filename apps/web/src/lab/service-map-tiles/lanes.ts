import { Array as Arr, Option, Order } from "effect"
import { type Cell, cellToPoint, corners, type Point } from "./hex"

// Railway lines. Two tiles that do not touch are joined by rail, and the track is laid along the
// borders between tiles: it follows hex sides from a corner of one tile to a corner of the other,
// so it never cuts through a village.

const cornerKey = ([x, z]: Point): string => `${Math.round(x * 100)},${Math.round(z * 100)}`

export interface Borders {
	readonly points: ReadonlyMap<string, Point>
	readonly next: ReadonlyMap<string, ReadonlyArray<string>>
}

/** The corner graph of the tiles on the board: one node per hex corner, one edge per tile side. */
export const bordersOf = (cells: ReadonlyArray<Cell>): Borders => {
	const points = new Map<string, Point>()
	const next = new Map<string, Array<string>>()
	const join = (a: string, b: string) => {
		const list = next.get(a)
		if (list === undefined) next.set(a, [b])
		else if (!list.includes(b)) list.push(b)
	}
	Arr.forEach(cells, (cell) => {
		const ring = corners(cell)
		Arr.forEach(ring, (point, index) => {
			const following = ring[(index + 1) % ring.length]
			if (following === undefined) return
			const a = cornerKey(point)
			const b = cornerKey(following)
			points.set(a, point)
			points.set(b, following)
			join(a, b)
			join(b, a)
		})
	})
	return { points, next }
}

const distance = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** The shortest run of tile sides from a corner of `from` to a corner of `to`, as points from one
 * tile's centre to the other's. Among equally short runs it leaves from the corner facing `to`.
 * Two tiles with no land between them get a straight line. */
export const laneBetween = (borders: Borders, from: Cell, to: Cell): ReadonlyArray<Point> => {
	const start = cellToPoint(from)
	const end = cellToPoint(to)
	const goals = new Set(Arr.map(corners(to), cornerKey))
	const sources = Arr.sort(
		Arr.filter(
			Arr.map(corners(from), (point) => ({ key: cornerKey(point), point })),
			(corner) => borders.points.has(corner.key),
		),
		Order.mapInput(Order.Number, (corner: { readonly point: Point }) => distance(corner.point, end)),
	)
	const cameFrom = new Map<string, string | null>(Arr.map(sources, (corner) => [corner.key, null]))
	const queue = Arr.map(sources, (corner) => corner.key)
	const reached = { key: Option.none<string>() }
	for (let index = 0; index < queue.length && Option.isNone(reached.key); index++) {
		const key = queue[index]
		if (key === undefined) break
		if (goals.has(key)) {
			reached.key = Option.some(key)
			break
		}
		const here = borders.points.get(key)
		// Neighbours nearest the destination first, so ties bend towards it instead of away.
		const onward = Arr.sort(
			Arr.filter(borders.next.get(key) ?? [], (other) => !cameFrom.has(other)),
			Order.mapInput(Order.Number, (other: string) =>
				distance(borders.points.get(other) ?? here ?? end, end),
			),
		)
		Arr.forEach(onward, (other) => {
			cameFrom.set(other, key)
			queue.push(other)
		})
	}
	if (Option.isNone(reached.key)) return [start, end]
	const path: Array<Point> = []
	let cursor: string | null = reached.key.value
	while (cursor !== null) {
		const point = borders.points.get(cursor)
		if (point !== undefined) path.unshift(point)
		cursor = cameFrom.get(cursor) ?? null
	}
	return [start, ...path, end]
}
