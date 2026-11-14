import { Array as Arr, Order } from "effect"
import type { Point } from "./hex"

// The railways as one network. Every rail link runs from a station, along tile borders, to
// another station, and links that share a border share its track. Where two of them part ways
// at a tile corner there is a set of points: one track in, two curves out.

export interface RailRoute {
	readonly id: string
	/** A station, the tile corners on the way, and the station at the other end. */
	readonly stops: ReadonlyArray<Point>
}

/** One stretch of track, drawn once however many routes run over it. */
export interface Piece {
	readonly key: string
	readonly line: ReadonlyArray<Point>
	readonly routes: ReadonlyArray<string>
}

/** A set of points: where it lies on the track, and the way a train faces as it runs into the junction. */
export interface Points {
	readonly at: Point
	readonly heading: number
	readonly routes: ReadonlyArray<string>
}

/** The end of a line: where the buffer stands, and the way the track leaves it. */
export interface Station {
	readonly at: Point
	readonly heading: number
	readonly routes: ReadonlyArray<string>
}

/** A stretch of a route that other routes also use, from `from` to `to` units along its line.
 * Stretches that touch belong to one `section`, and a section holds one train at a time. */
export interface Block {
	readonly section: string
	readonly from: number
	readonly to: number
}

export interface RailNetwork {
	readonly pieces: ReadonlyArray<Piece>
	readonly points: ReadonlyArray<Points>
	readonly stations: ReadonlyArray<Station>
	/** The line each route's train follows, station to station. */
	readonly paths: ReadonlyMap<string, ReadonlyArray<Point>>
	/** The shared stretches of each route, in the order its train meets them. */
	readonly blocks: ReadonlyMap<string, ReadonlyArray<Block>>
}

const lengthOf = (line: ReadonlyArray<Point>): number =>
	Arr.reduce(Arr.zip(line, Arr.drop(line, 1)), 0, (sum, [a, b]) => sum + span(a, b))

/** One piece of a route's line: what it runs over, and where along the line it lies. */
interface Stretch {
	readonly resource: string
	readonly from: number
	readonly to: number
}

/** How far before a corner a track starts to turn, at most. */
const CUT = 1.15
const TURN_STEPS = 8

const keyOf = ([x, z]: Point): string => `${Math.round(x * 100)},${Math.round(z * 100)}`
const sideKey = (a: Point, b: Point): string => Arr.join(Arr.sort([keyOf(a), keyOf(b)], Order.String), "~")
const span = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** The point on the side from `corner` to `towards` where the turn at `corner` begins. The cut
 * depends only on the side's length, so every route over that side turns at the same spot. */
const cutFrom = (corner: Point, towards: Point): Point => {
	const length = span(corner, towards)
	const cut = Math.min(CUT, length * 0.45)
	return [
		corner[0] + ((towards[0] - corner[0]) / length) * cut,
		corner[1] + ((towards[1] - corner[1]) / length) * cut,
	]
}

/** A turn from `from` to `to` that leaves and arrives along the two sides meeting at `corner`. */
const turn = (from: Point, corner: Point, to: Point): ReadonlyArray<Point> =>
	Arr.makeBy(TURN_STEPS + 1, (index): Point => {
		const t = index / TURN_STEPS
		const [a, b, c] = [(1 - t) * (1 - t), 2 * t * (1 - t), t * t]
		return [a * from[0] + b * corner[0] + c * to[0], a * from[1] + b * corner[1] + c * to[1]]
	})

interface Tally<A> {
	readonly value: A
	readonly routes: Set<string>
}

const note = <A>(tallies: Map<string, Tally<A>>, key: string, value: A, route: string): void => {
	const seen = tallies.get(key)
	if (seen === undefined) tallies.set(key, { value, routes: new Set([route]) })
	else seen.routes.add(route)
}

export const railNetwork = (routes: ReadonlyArray<RailRoute>): RailNetwork => {
	const pieces = new Map<string, Tally<ReadonlyArray<Point>>>()
	const stations = new Map<string, Tally<{ readonly at: Point; readonly heading: number }>>()
	/** Per end of a side at a corner: where it is cut, and the turns that leave it. */
	const ends = new Map<
		string,
		{ readonly at: Point; readonly corner: Point; readonly turns: Map<string, Set<string>> }
	>()
	const paths = new Map<string, ReadonlyArray<Point>>()
	const stretches = new Map<string, Array<Stretch>>()
	/** What may hold only one train: a side of track, or a whole corner (its turns cross). */
	const users = new Map<string, Set<string>>()
	const leave = (corner: Point, other: Point, at: Point, turnKey: string, route: string) => {
		const key = `${keyOf(corner)}|${sideKey(corner, other)}`
		const end = ends.get(key) ?? { at, corner, turns: new Map<string, Set<string>>() }
		ends.set(key, end)
		const users = end.turns.get(turnKey) ?? new Set<string>()
		end.turns.set(turnKey, users)
		users.add(route)
	}
	Arr.forEach(routes, ({ id, stops: raw }) => {
		// Two stops on one spot give a side no length to turn on.
		const stops = Arr.filter(raw, (stop, index) => {
			const before = raw[index - 1]
			return before === undefined || span(before, stop) > 1e-6
		})
		const [first, second] = [stops[0], stops[1]]
		const last = stops[stops.length - 1]
		const beforeLast = stops[stops.length - 2]
		if (first === undefined || second === undefined || last === undefined || beforeLast === undefined)
			return
		const heading = (from: Point, to: Point) => Math.atan2(to[1] - from[1], to[0] - from[0])
		note(stations, keyOf(first), { at: first, heading: heading(first, second) }, id)
		note(stations, keyOf(last), { at: last, heading: heading(last, beforeLast) }, id)
		const path: Array<Point> = [first]
		const cursor = { at: first, stop: first, travelled: 0 }
		const run: Array<Stretch> = []
		const over = (resource: string, line: ReadonlyArray<Point>) => {
			const to = cursor.travelled + lengthOf(line)
			run.push({ resource, from: cursor.travelled, to })
			cursor.travelled = to
			const seen = users.get(resource) ?? new Set<string>()
			users.set(resource, seen)
			seen.add(id)
		}
		Arr.forEach(stops, (corner, index) => {
			const before = stops[index - 1]
			const after = stops[index + 1]
			if (before === undefined || after === undefined) return
			const cutIn = cutFrom(corner, before)
			const cutOut = cutFrom(corner, after)
			note(pieces, `side:${sideKey(before, corner)}`, [cursor.at, cutIn], id)
			over(`side:${sideKey(before, corner)}`, [cursor.at, cutIn])
			const turnKey = `turn:${keyOf(corner)}:${Arr.join(
				Arr.sort([sideKey(before, corner), sideKey(corner, after)], Order.String),
				"+",
			)}`
			const curve = turn(cutIn, corner, cutOut)
			note(pieces, turnKey, curve, id)
			over(`corner:${keyOf(corner)}`, curve)
			leave(corner, before, cutIn, turnKey, id)
			leave(corner, after, cutOut, turnKey, id)
			path.push(...curve)
			cursor.at = cutOut
			cursor.stop = corner
		})
		note(pieces, `side:${sideKey(cursor.stop, last)}`, [cursor.at, last], id)
		over(`side:${sideKey(cursor.stop, last)}`, [cursor.at, last])
		path.push(last)
		paths.set(id, path)
		stretches.set(id, run)
	})
	const isShared = (resource: string): boolean => (users.get(resource)?.size ?? 0) > 1
	// Shared stretches that follow one another on any route are one section.
	const parents = new Map<string, string>()
	const sectionOf = (resource: string): string => {
		const parent = parents.get(resource)
		if (parent === undefined || parent === resource) return resource
		const root = sectionOf(parent)
		parents.set(resource, root)
		return root
	}
	stretches.forEach((run) =>
		Arr.forEach(Arr.zip(run, Arr.drop(run, 1)), ([a, b]) => {
			if (!isShared(a.resource) || !isShared(b.resource)) return
			const [first, second] = Arr.sort([sectionOf(a.resource), sectionOf(b.resource)], Order.String)
			if (first !== undefined && second !== undefined && first !== second) parents.set(second, first)
		}),
	)
	const blocks = new Map<string, ReadonlyArray<Block>>()
	stretches.forEach((run, id) => {
		const found: Array<{ section: string; from: number; to: number }> = []
		Arr.forEach(run, (stretch, index) => {
			if (!isShared(stretch.resource)) return
			const before = run[index - 1]
			const open = found[found.length - 1]
			// A shared stretch straight after another carries on the same block.
			if (open !== undefined && before !== undefined && isShared(before.resource)) open.to = stretch.to
			else found.push({ section: sectionOf(stretch.resource), from: stretch.from, to: stretch.to })
		})
		blocks.set(id, found)
	})
	return {
		pieces: Arr.map([...pieces], ([key, piece]) => ({
			key,
			line: piece.value,
			routes: [...piece.routes],
		})),
		// A side's end with two turns leaving it is where two routes part: a set of points.
		points: Arr.flatMap([...ends.values()], (end) =>
			end.turns.size < 2
				? []
				: [
						{
							at: end.at,
							heading: Math.atan2(end.corner[1] - end.at[1], end.corner[0] - end.at[0]),
							routes: Arr.dedupe(Arr.flatMap([...end.turns.values()], (users) => [...users])),
						},
					],
		),
		stations: Arr.map([...stations.values()], (station) => ({
			...station.value,
			routes: [...station.routes],
		})),
		paths,
		blocks,
	}
}
