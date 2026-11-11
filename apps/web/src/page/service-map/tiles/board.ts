import { Array as Arr, Option, Order } from "effect"
import type { Topology3D } from "../three/types"
import { type Cell, cellKey, cellToPoint, hexDistance, neighbours, ORIGIN, type Point, sameCell } from "./hex"

// The tile game over a topology: every service is one hex tile, and a call between two services
// is a road when their tiles share a side and a railway when they do not. Laying the map out
// well means turning railways into roads.

export type Placements = ReadonlyMap<string, Cell>

/** One connection between two services, whichever way the calls go. */
export interface Link {
	readonly id: string
	/** The busier direction's caller and callee. */
	readonly source: string
	readonly target: string
	readonly callsPerSecond: number
	readonly errorRate: number
	readonly dimmed: boolean
}

type Topology = Pick<Topology3D, "nodes" | "edges">

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)

/** The topology's edges folded into unordered pairs between known nodes; self calls are dropped. */
export const linksOf = (topology: Topology): ReadonlyArray<Link> => {
	const known = new Set(Arr.map(topology.nodes, (node) => node.id))
	const links = new Map<string, Link>()
	Arr.forEach(topology.edges, (edge) => {
		if (edge.source === edge.target || !known.has(edge.source) || !known.has(edge.target)) return
		const id = pairKey(edge.source, edge.target)
		const previous = links.get(id)
		if (previous === undefined) {
			links.set(id, {
				id,
				source: edge.source,
				target: edge.target,
				callsPerSecond: edge.callsPerSecond,
				errorRate: edge.errorRate,
				dimmed: edge.dimmed === true,
			})
			return
		}
		const calls = previous.callsPerSecond + edge.callsPerSecond
		const busier = edge.callsPerSecond > previous.callsPerSecond ? edge : previous
		links.set(id, {
			id,
			source: busier.source,
			target: busier.target,
			callsPerSecond: calls,
			errorRate:
				calls === 0
					? Math.max(previous.errorRate, edge.errorRate)
					: (previous.errorRate * previous.callsPerSecond + edge.errorRate * edge.callsPerSecond) /
						calls,
			dimmed: previous.dimmed && edge.dimmed === true,
		})
	})
	return [...links.values()]
}

/** How hard a link pulls its two tiles together: every link counts, busy ones a little more. */
const pull = (link: Link): number => 1 + Math.log10(1 + link.callsPerSecond)

interface Neighbour {
	readonly other: string
	readonly weight: number
}

const adjacencyOf = (links: ReadonlyArray<Link>): ReadonlyMap<string, ReadonlyArray<Neighbour>> => {
	const adjacency = new Map<string, Array<Neighbour>>()
	const add = (id: string, other: string, weight: number) => {
		const list = adjacency.get(id)
		if (list === undefined) adjacency.set(id, [{ other, weight }])
		else list.push({ other, weight })
	}
	Arr.forEach(links, (link) => {
		add(link.source, link.target, pull(link))
		add(link.target, link.source, pull(link))
	})
	return adjacency
}

const byCell = Order.combine(
	Order.mapInput(Order.Number, (cell: Cell) => hexDistance(cell, ORIGIN)),
	Order.combine(
		Order.mapInput(Order.Number, (cell: Cell) => cell.r),
		Order.mapInput(Order.Number, (cell: Cell) => cell.q),
	),
)

/** Free cells that share a side with a tile, nearest the middle first; the middle on an empty board. */
const frontier = (taken: ReadonlyMap<string, string>, cells: Placements, without?: string): Array<Cell> => {
	const found = new Map<string, Cell>()
	cells.forEach((cell, id) => {
		if (id === without) return
		Arr.forEach(neighbours(cell), (next) => {
			const key = cellKey(next)
			const occupant = taken.get(key)
			if (occupant === undefined || occupant === without) found.set(key, next)
		})
	})
	if (found.size === 0) return [ORIGIN]
	return Arr.sort([...found.values()], byCell)
}

const takenOf = (cells: Placements): Map<string, string> =>
	new Map(Arr.map([...cells], ([id, cell]) => [cellKey(cell), id] as const))

/** Tiles in the order they are dealt: the best connected first, then whichever unplaced tile is
 * tied closest to what is already down, so a drawn tile nearly always has a neighbour to touch. */
export const dealOrder = (
	topology: Topology,
	placed: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> => {
	const adjacency = adjacencyOf(linksOf(topology))
	const degree = (id: string) => Arr.reduce(adjacency.get(id) ?? [], 0, (sum, next) => sum + next.weight)
	const down = new Set(placed)
	const pending = new Set(
		Arr.filter(
			Arr.map(topology.nodes, (node) => node.id),
			(id) => !down.has(id),
		),
	)
	const order: Array<string> = []
	const attachment = (id: string) =>
		Arr.reduce(adjacency.get(id) ?? [], 0, (sum, next) => sum + (down.has(next.other) ? next.weight : 0))
	const byPriority = Order.combine(
		Order.flip(Order.mapInput(Order.Number, attachment)),
		Order.combine(Order.flip(Order.mapInput(Order.Number, degree)), Order.String),
	)
	while (pending.size > 0) {
		const next = Arr.head(Arr.sort([...pending], byPriority))
		if (Option.isNone(next)) break
		order.push(next.value)
		pending.delete(next.value)
		down.add(next.value)
	}
	return order
}

/** Weight of the compactness and namespace terms next to a link's pull (at least 1 per step). */
const SPREAD_COST = 0.06
const NAMESPACE_BONUS = 0.6
/** What it costs a tile to stand beside one it has nothing to do with: another namespace's, with
 * no link between them. It leaves gaps of open country between unrelated services. */
const STRANGER_COST = 0.45
/** Up to this many tiles, every pair is tried for a swap. Past it, a tile only trades with the
 * tiles near its own links or itself: trying every pair grows with the square of the board, and a
 * swap far from both cannot shorten its roads. */
const EXHAUSTIVE_SWAPS = 60
const SWAP_REACH = 2

/** Lays every node out on the board. `pinned` tiles stay where they are. Greedy first (each tile
 * goes where the most of its links become roads), then moves and swaps while they shorten the connections. */
export const autoLayout = (topology: Topology, pinned: Placements = new Map()): Map<string, Cell> => {
	const adjacency = adjacencyOf(linksOf(topology))
	const namespaces = new Map(Arr.map(topology.nodes, (node) => [node.id, node.namespace] as const))
	const cells = new Map(Arr.filter([...pinned], ([id]) => namespaces.has(id)))
	const taken = takenOf(cells)
	const linkedTo = new Map(
		Arr.map([...adjacency], ([id, list]) => [id, new Set(Arr.map(list, (next) => next.other))] as const),
	)
	const noLinks: ReadonlySet<string> = new Set()
	/** What `id` costs standing on `cell`, given everything else on the board. */
	const cost = (id: string, cell: Cell): number => {
		const reach = Arr.reduce(adjacency.get(id) ?? [], 0, (sum, next) => {
			const other = cells.get(next.other)
			return other === undefined ? sum : sum + next.weight * Math.max(0, hexDistance(cell, other) - 1)
		})
		const kin = Arr.filter(neighbours(cell), (next) => {
			const occupant = taken.get(cellKey(next))
			return (
				occupant !== undefined && occupant !== id && namespaces.get(occupant) === namespaces.get(id)
			)
		}).length
		const linked = linkedTo.get(id) ?? noLinks
		const strangers = Arr.filter(neighbours(cell), (next) => {
			const occupant = taken.get(cellKey(next))
			return (
				occupant !== undefined &&
				occupant !== id &&
				namespaces.get(occupant) !== namespaces.get(id) &&
				!linked.has(occupant)
			)
		}).length
		return (
			reach +
			SPREAD_COST * hexDistance(cell, ORIGIN) -
			NAMESPACE_BONUS * kin +
			STRANGER_COST * strangers
		)
	}
	const put = (id: string, cell: Cell) => {
		const previous = cells.get(id)
		if (previous !== undefined && taken.get(cellKey(previous)) === id) taken.delete(cellKey(previous))
		cells.set(id, cell)
		taken.set(cellKey(cell), id)
	}
	/** The option `id` costs least on, ties to the cell nearest the middle (`byCell`). */
	const cheapest = (id: string, options: ReadonlyArray<Cell>): Option.Option<Cell> =>
		Arr.reduce(options, Option.none<{ readonly cell: Cell; readonly cost: number }>(), (best, cell) => {
			const here = cost(id, cell)
			return Option.isSome(best) &&
				(best.value.cost < here || (best.value.cost === here && byCell(best.value.cell, cell) <= 0))
				? best
				: Option.some({ cell, cost: here })
		}).pipe(Option.map((best) => best.cell))
	Arr.forEach(dealOrder(topology, new Set(cells.keys())), (id) =>
		Option.map(cheapest(id, frontier(taken, cells)), (cell) => put(id, cell)),
	)
	const movable = Arr.sort(
		Arr.filter([...cells.keys()], (id) => !pinned.has(id)),
		Order.String,
	)
	/** Who `id` may trade places with: everyone on a small board, else the tiles near it or its links. */
	const partnersOf = (id: string): ReadonlyArray<string> => {
		if (movable.length <= EXHAUSTIVE_SWAPS) return movable
		const anchors = Arr.flatMap([id, ...(linkedTo.get(id) ?? noLinks)], (other) =>
			Option.toArray(Option.fromNullishOr(cells.get(other))),
		)
		return Arr.filter(movable, (other) => {
			const there = cells.get(other)
			return (
				there !== undefined && Arr.some(anchors, (anchor) => hexDistance(anchor, there) <= SWAP_REACH)
			)
		})
	}
	for (let round = 0; round < 10; round++) {
		let improved = false
		for (const id of movable) {
			const home = cells.get(id)
			if (home === undefined) continue
			const here = cost(id, home)
			const better = Option.filter(
				cheapest(id, frontier(taken, cells, id)),
				(cell) => cost(id, cell) < here - 1e-9,
			)
			if (Option.isSome(better)) {
				put(id, better.value)
				improved = true
				continue
			}
			for (const other of partnersOf(id)) {
				const there = cells.get(other)
				const current = cells.get(id)
				if (other === id || there === undefined || current === undefined) continue
				const before = cost(id, current) + cost(other, there)
				put(id, there)
				put(other, current)
				if (cost(id, there) + cost(other, current) < before - 1e-9) {
					improved = true
					continue
				}
				put(other, there)
				put(id, current)
			}
		}
		if (!improved) break
	}
	return cells
}

export interface Targets {
	/** Empty cells beside a tile: the held tile can go there. */
	readonly free: ReadonlyArray<Cell>
	/** Other tiles the held tile can trade places with (only a tile already on the board trades). */
	readonly swaps: ReadonlyArray<Cell>
}

/** Every cell the held tile may be put down on: its own, the free ones and the tiles it trades with. */
export const placesOf = (cells: Placements, heldId: string, targets: Targets): ReadonlyArray<Cell> => {
	const home = cells.get(heldId)
	return [...(home === undefined ? [] : [home]), ...targets.free, ...targets.swaps]
}

/** The place one keyboard step on from `from`: the nearest one in `direction` (a vector on the
 * board), a place off to the side counting as further away. `from` itself when none lies that way. */
export const stepTarget = (places: ReadonlyArray<Cell>, from: Cell, direction: Point): Cell => {
	const [fromX, fromZ] = cellToPoint(from)
	const length = Math.max(1e-9, Math.hypot(direction[0], direction[1]))
	const [wayX, wayZ] = [direction[0] / length, direction[1] / length]
	const best = Arr.reduce(places, { cell: from, cost: Infinity }, (found, cell) => {
		const [x, z] = cellToPoint(cell)
		const ahead = (x - fromX) * wayX + (z - fromZ) * wayZ
		const aside = Math.abs((x - fromX) * wayZ - (z - fromZ) * wayX)
		// Only a place within sixty degrees or so of the way pressed lies that way.
		const cost = ahead > 1e-6 && aside <= ahead * 2 ? ahead + aside : Infinity
		return cost < found.cost - 1e-9 ? { cell, cost } : found
	})
	return best.cell
}

/** Where the held tile may be put down. */
export const targetsFor = (cells: Placements, heldId: string): Targets => {
	const taken = takenOf(cells)
	const home = cells.get(heldId)
	return {
		free: frontier(taken, cells, heldId),
		swaps:
			home === undefined
				? []
				: Arr.map(
						Arr.filter([...cells], ([id]) => id !== heldId),
						([, cell]) => cell,
					),
	}
}

/** The board after `id` is put on `cell`, trading places with a tile already there; `None` when
 * the cell is not one of `targetsFor`. Putting a tile back where it stands changes nothing. */
export const placeTile = (cells: Placements, id: string, cell: Cell): Option.Option<Map<string, Cell>> => {
	const home = cells.get(id)
	if (home !== undefined && sameCell(home, cell)) return Option.some(new Map(cells))
	const targets = targetsFor(cells, id)
	const occupant = Arr.findFirst([...cells], ([other, at]) => other !== id && sameCell(at, cell))
	const next = new Map(cells)
	if (Option.isSome(occupant)) {
		if (home === undefined) return Option.none()
		next.set(occupant.value[0], home)
		next.set(id, cell)
		return Option.some(next)
	}
	if (!Arr.some(targets.free, (free) => sameCell(free, cell))) return Option.none()
	next.set(id, cell)
	return Option.some(next)
}

export type LinkState = "road" | "rail" | "waiting"

/** A link is a road between touching tiles, a railway between distant ones, and waits for a tile still in the stack. */
export const linkState = (cells: Placements, link: Link): LinkState => {
	const from = cells.get(link.source)
	const to = cells.get(link.target)
	if (from === undefined || to === undefined) return "waiting"
	return hexDistance(from, to) === 1 ? "road" : "rail"
}

export interface Tally {
	readonly total: number
	readonly roads: number
	readonly rails: number
	readonly waiting: number
	/** Share of all calls per second that travel by road, 0 to 1. */
	readonly roadTraffic: number
}

export const tally = (links: ReadonlyArray<Link>, cells: Placements): Tally => {
	const states = Arr.map(links, (link) => ({ link, state: linkState(cells, link) }))
	const count = (state: LinkState) => Arr.filter(states, (entry) => entry.state === state).length
	const calls = (entries: typeof states) =>
		Arr.reduce(entries, 0, (sum, entry) => sum + entry.link.callsPerSecond)
	const all = calls(states)
	return {
		total: links.length,
		roads: count("road"),
		rails: count("rail"),
		waiting: count("waiting"),
		roadTraffic: all === 0 ? 0 : calls(Arr.filter(states, (entry) => entry.state === "road")) / all,
	}
}

export interface Prospect {
	/** The held tile's own links at that cell. */
	readonly roads: number
	readonly rails: number
	/** Roads the whole board gains or loses by the move (a trade can cost the other tile some). */
	readonly gain: number
}

/** What putting `id` on `cell` would do; `None` when it cannot go there. */
export const prospect = (
	links: ReadonlyArray<Link>,
	cells: Placements,
	id: string,
	cell: Cell,
): Option.Option<Prospect> =>
	Option.map(placeTile(cells, id, cell), (next) => {
		const own = tally(
			Arr.filter(links, (link) => link.source === id || link.target === id),
			next,
		)
		return {
			roads: own.roads,
			rails: own.rails,
			gain: tally(links, next).roads - tally(links, cells).roads,
		}
	})

/** A free cell on the coast and how many of its six sides touch a tile. */
interface Shore {
	readonly cell: Cell
	readonly shelter: number
}

/** Where water gathers on its own: the free cells the land closes in on. Every cell with tiles on
 * four or more sides floods, up to three of them, and when the coast has no such bay the most
 * sheltered cell does, so the board always has one lake. A tile put on a lake drains it. */
export const lakesOf = (cells: Placements, without?: string): ReadonlyArray<Cell> => {
	const taken = takenOf(cells)
	const shelter = (cell: Cell): number =>
		Arr.filter(neighbours(cell), (next) => {
			const occupant = taken.get(cellKey(next))
			return occupant !== undefined && occupant !== without
		}).length
	if (Arr.every([...cells.keys()], (id) => id === without)) return []
	const shores = Arr.sort(
		Arr.map(frontier(taken, cells, without), (cell): Shore => ({ cell, shelter: shelter(cell) })),
		Order.combine(
			Order.flip(Order.mapInput(Order.Number, (shore: Shore) => shore.shelter)),
			Order.mapInput(byCell, (shore: Shore) => shore.cell),
		),
	)
	const bays = Arr.take(
		Arr.filter(shores, (shore) => shore.shelter >= 4),
		3,
	)
	return Arr.map(bays.length > 0 ? bays : Arr.take(shores, 1), (shore) => shore.cell)
}

/** A cell of open country: `ring` 1 touches a tile, `ring` 2 lies one cell further out. */
export interface Wild {
	readonly cell: Cell
	readonly ring: 1 | 2
}

/** Whether a cell two steps out is land: a little over half are, so the coast is ragged. */
const isOuterLand = (cell: Cell): boolean =>
	((Math.imul(cell.q, 73856093) ^ Math.imul(cell.r, 19349663)) >>> 0) % 100 < 42

/** The open country round the tiles: every free cell that touches a tile and is not a lake, and
 * some of the cells beyond those. A tile put on one of them takes its place. */
export const wildsOf = (
	cells: Placements,
	lakes: ReadonlyArray<Cell>,
	without?: string,
): ReadonlyArray<Wild> => {
	if (Arr.every([...cells.keys()], (id) => id === without)) return []
	const taken = takenOf(cells)
	const flooded = new Set(Arr.map(lakes, cellKey))
	const inner = Arr.filter(frontier(taken, cells, without), (cell) => !flooded.has(cellKey(cell)))
	const used = new Set([
		...flooded,
		...Arr.map(inner, cellKey),
		...Arr.map(
			Arr.filter([...cells], ([id]) => id !== without),
			([, cell]) => cellKey(cell),
		),
	])
	const outer = new Map<string, Cell>()
	Arr.forEach([...inner, ...lakes], (cell) =>
		Arr.forEach(neighbours(cell), (next) => {
			if (!used.has(cellKey(next)) && isOuterLand(next)) outer.set(cellKey(next), next)
		}),
	)
	return [
		...Arr.map(inner, (cell): Wild => ({ cell, ring: 1 })),
		...Arr.map(Arr.sort([...outer.values()], byCell), (cell): Wild => ({ cell, ring: 2 })),
	]
}
