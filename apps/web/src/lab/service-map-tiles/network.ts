import { Array as Arr } from "effect"
import { type Link, linkState, type Placements } from "./board"
import { type Cell, cellToPoint, type Point } from "./hex"
import { bordersOf, cornerKey, laneBetween } from "./lanes"

// What joins the tiles on the board: a road straight across the side two touching tiles share,
// and a railway along the tile borders for every other link. Each tile also learns which ways
// its roads and tracks leave, so its houses and trees can keep those corridors clear.

export interface Road {
	readonly link: Link
	readonly from: Point
	readonly to: Point
}

export interface Rail {
	readonly link: Link
	/** The station by one village, the tile corners the track passes, the station by the other. */
	readonly points: ReadonlyArray<Point>
}

export interface Network {
	readonly roads: ReadonlyArray<Road>
	readonly rails: ReadonlyArray<Rail>
	/** Per tile, the directions (radians, from its centre) its roads and tracks leave in. */
	readonly corridors: ReadonlyMap<string, ReadonlyArray<number>>
}

/** How far from a village's middle its railway station stands, towards the tile corner. */
export const STATION_DISTANCE = 1.15

const towards = (from: Point, to: Point): number => Math.atan2(to[1] - from[1], to[0] - from[0])

const stationOf = (centre: Point, corner: Point): Point => {
	const angle = towards(centre, corner)
	return [centre[0] + Math.cos(angle) * STATION_DISTANCE, centre[1] + Math.sin(angle) * STATION_DISTANCE]
}

/** The roads and railways between the tiles on the board. A tile in hand (`without`) is left out:
 * its links are drawn again when it lands. */
export const networkOf = (
	links: ReadonlyArray<Link>,
	cells: Placements,
	without: string | null,
	country: ReadonlyArray<Cell> = [],
): Network => {
	const down = new Map(Arr.filter([...cells], ([id]) => id !== without))
	// Lakes and open country are land as far as a railway is concerned: the track runs along
	// their borders too.
	const borders = bordersOf([...down.values(), ...country])
	const corridors = new Map<string, Array<number>>()
	const leave = (id: string, angle: number) => {
		const list = corridors.get(id)
		if (list === undefined) corridors.set(id, [angle])
		else list.push(angle)
	}
	const roads: Array<Road> = []
	const rails: Array<Rail> = []
	/** Per tile, the corners its lines already end at: the next line takes another one, so every
	 * line has a platform of its own and no two trains share a home. */
	const stations = new Map<string, Set<string>>()
	const stationsOf = (id: string): Set<string> => {
		const used = stations.get(id) ?? new Set<string>()
		stations.set(id, used)
		return used
	}
	Arr.forEach(links, (link) => {
		const source = down.get(link.source)
		const target = down.get(link.target)
		if (source === undefined || target === undefined) return
		const from = cellToPoint(source)
		const to = cellToPoint(target)
		if (linkState(down, link) === "road") {
			roads.push({ link, from, to })
			leave(link.source, towards(from, to))
			leave(link.target, towards(to, from))
			return
		}
		const lane = laneBetween(borders, source, target, {
			from: stationsOf(link.source),
			to: stationsOf(link.target),
		})
		const first = lane[1] ?? to
		const last = lane[lane.length - 2] ?? from
		stationsOf(link.source).add(cornerKey(first))
		stationsOf(link.target).add(cornerKey(last))
		rails.push({ link, points: [stationOf(from, first), ...lane.slice(1, -1), stationOf(to, last)] })
		leave(link.source, towards(from, first))
		leave(link.target, towards(to, last))
	})
	return { roads, rails, corridors }
}
