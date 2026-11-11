import { Array as Arr, Option, Order } from "effect"
import { type Cell, cellToPoint, corners, disc, hexDistance, type Point } from "./hex"

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

/** The shortest run of sides in `borders` from a corner of `from` to a corner of `to`; `None`
 * when the graph does not join them. Among equally short runs it leaves from the corner facing `to`. */
const runBetween = (borders: Borders, from: Cell, to: Cell): Option.Option<ReadonlyArray<Point>> => {
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
	return Option.map(reached.key, (last) => {
		const path: Array<Point> = []
		let cursor: string | null = last
		while (cursor !== null) {
			const point = borders.points.get(cursor)
			if (point !== undefined) path.unshift(point)
			cursor = cameFrom.get(cursor) ?? null
		}
		return path
	})
}

/** The track between two tiles, as points from one tile's centre to the other's: the shortest
 * run of tile sides the land offers. Two tiles the land does not join are linked across the
 * open cells between them, still along cell sides, so the track never cuts through a tile. */
export const laneBetween = (borders: Borders, from: Cell, to: Cell): ReadonlyArray<Point> => {
	const overLand = runBetween(borders, from, to)
	const run = Option.orElse(overLand, () =>
		runBetween(bordersOf(disc(from, hexDistance(from, to))), from, to),
	)
	return [cellToPoint(from), ...Option.getOrElse(run, (): ReadonlyArray<Point> => []), cellToPoint(to)]
}
