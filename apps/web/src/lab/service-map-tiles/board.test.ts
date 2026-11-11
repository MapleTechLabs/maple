import { Array as Arr, Option } from "effect"
import { describe, expect, it } from "vitest"
import type { Edge3D, Node3D } from "../../page/service-map/three/types"
import { SERVICE_MAP_3D_TOPOLOGY } from "../service-map-3d/fixture"
import {
	autoLayout,
	dealOrder,
	lakesOf,
	linksOf,
	linkState,
	placeTile,
	prospect,
	tally,
	targetsFor,
} from "./board"
import { type Cell, cellKey, disc, hexDistance } from "./hex"

const node = (id: string, namespace = "shop"): Node3D => ({
	id,
	label: id,
	kind: "service",
	namespace,
	platform: "kubernetes",
	throughput: 10,
	errorRate: 0,
})

const edge = (source: string, target: string, callsPerSecond = 10, errorRate = 0): Edge3D => ({
	source,
	target,
	callsPerSecond,
	errorRate,
	avgLatencyMs: 1,
})

const topologyOf = (ids: ReadonlyArray<string>, edges: ReadonlyArray<Edge3D>) => ({
	nodes: Arr.map(ids, (id) => node(id)),
	edges,
})

const board = (entries: ReadonlyArray<readonly [string, Cell]>) => new Map(entries)

describe("linksOf", () => {
	it("folds calls in both directions into one link pointing the busier way", () => {
		const links = linksOf(topologyOf(["a", "b"], [edge("a", "b", 10, 0.1), edge("b", "a", 30, 0.02)]))
		expect(links).toHaveLength(1)
		expect(links[0]).toMatchObject({ source: "b", target: "a", callsPerSecond: 40 })
		expect(links[0]?.errorRate).toBeCloseTo(0.04)
	})

	it("drops self calls and calls to a node that is not on the map", () => {
		const links = linksOf(topologyOf(["a", "b"], [edge("a", "a"), edge("a", "ghost"), edge("a", "b")]))
		expect(Arr.map(links, (link) => [link.source, link.target])).toEqual([["a", "b"]])
	})
})

describe("autoLayout", () => {
	it("gives every node its own cell", () => {
		const cells = autoLayout(SERVICE_MAP_3D_TOPOLOGY)
		expect(cells.size).toBe(SERVICE_MAP_3D_TOPOLOGY.nodes.length)
		expect(new Set(Arr.map([...cells.values()], cellKey)).size).toBe(cells.size)
	})

	it("joins every link of a chain and of a hub with six spokes by road", () => {
		const chain = topologyOf(["a", "b", "c", "d"], [edge("a", "b"), edge("b", "c"), edge("c", "d")])
		const hub = topologyOf(
			["hub", "s1", "s2", "s3", "s4", "s5", "s6"],
			Arr.map(["s1", "s2", "s3", "s4", "s5", "s6"], (spoke) => edge("hub", spoke)),
		)
		expect(tally(linksOf(chain), autoLayout(chain))).toMatchObject({ roads: 3, rails: 0 })
		expect(tally(linksOf(hub), autoLayout(hub))).toMatchObject({ roads: 6, rails: 0 })
	})

	it("puts most of the sample map's traffic on roads", () => {
		const score = tally(linksOf(SERVICE_MAP_3D_TOPOLOGY), autoLayout(SERVICE_MAP_3D_TOPOLOGY))
		expect(score.roads / score.total).toBeGreaterThan(0.8)
		expect(score.roadTraffic).toBeGreaterThan(0.85)
	})

	it("leaves pinned tiles where they are and lays the rest out around them", () => {
		const topology = topologyOf(["a", "b", "c"], [edge("a", "b"), edge("b", "c")])
		const cells = autoLayout(topology, board([["a", { q: 4, r: -2 }]]))
		expect(cells.get("a")).toEqual({ q: 4, r: -2 })
		expect(hexDistance(cells.get("b") ?? { q: 0, r: 0 }, { q: 4, r: -2 })).toBe(1)
		expect(tally(linksOf(topology), cells).roads).toBe(2)
	})

	it("is the same on every run", () => {
		expect([...autoLayout(SERVICE_MAP_3D_TOPOLOGY)]).toEqual([...autoLayout(SERVICE_MAP_3D_TOPOLOGY)])
	})
})

describe("dealOrder", () => {
	it("deals the best connected tile first, then tiles that touch what is already down", () => {
		const topology = topologyOf(
			["leaf", "hub", "mid", "far"],
			[edge("hub", "leaf"), edge("hub", "mid"), edge("mid", "far")],
		)
		const order = dealOrder(topology)
		expect(order[0]).toBe("hub")
		expect(order.indexOf("far")).toBeGreaterThan(order.indexOf("mid"))
	})

	it("deals every tile of the sample map once, each after one it connects to", () => {
		const order = dealOrder(SERVICE_MAP_3D_TOPOLOGY)
		const links = linksOf(SERVICE_MAP_3D_TOPOLOGY)
		expect([...order].sort()).toEqual(Arr.map(SERVICE_MAP_3D_TOPOLOGY.nodes, (item) => item.id).sort())
		const orphans = Arr.filter(Arr.drop(order, 1), (id) => {
			const earlier = new Set(Arr.take(order, order.indexOf(id)))
			return !Arr.some(
				links,
				(link) =>
					(link.source === id && earlier.has(link.target)) ||
					(link.target === id && earlier.has(link.source)),
			)
		})
		expect(orphans).toEqual([])
	})
})

describe("placing a tile", () => {
	const cells = board([
		["a", { q: 0, r: 0 }],
		["b", { q: 1, r: 0 }],
	])

	it("takes a new tile on a free cell beside a tile, and nowhere else", () => {
		expect(Option.map(placeTile(cells, "c", { q: 2, r: 0 }), (next) => next.get("c"))).toEqual(
			Option.some({ q: 2, r: 0 }),
		)
		expect(placeTile(cells, "c", { q: 4, r: 0 })).toEqual(Option.none())
	})

	it("does not let a tile from the stack land on an occupied cell", () => {
		expect(placeTile(cells, "c", { q: 1, r: 0 })).toEqual(Option.none())
	})

	it("trades places when a tile on the board is put on another one", () => {
		const next = Option.getOrThrow(placeTile(cells, "a", { q: 1, r: 0 }))
		expect([next.get("a"), next.get("b")]).toEqual([
			{ q: 1, r: 0 },
			{ q: 0, r: 0 },
		])
	})

	it("does not count a lifted tile's own cell as something to stand beside", () => {
		const targets = targetsFor(cells, "b")
		expect(Arr.every(targets.free, (cell) => hexDistance(cell, { q: 0, r: 0 }) === 1)).toBe(true)
		expect(targets.swaps).toEqual([{ q: 0, r: 0 }])
	})

	it("offers only the middle cell on an empty board", () => {
		expect(targetsFor(board([]), "a")).toEqual({ free: [{ q: 0, r: 0 }], swaps: [] })
	})
})

describe("scoring", () => {
	const topology = topologyOf(
		["a", "b", "c", "d"],
		[edge("a", "b", 90), edge("a", "c", 10), edge("c", "d", 5)],
	)
	const links = linksOf(topology)
	const cells = board([
		["a", { q: 0, r: 0 }],
		["b", { q: 1, r: 0 }],
		["c", { q: 3, r: 0 }],
	])

	it("joins touching tiles by road, distant ones by rail, and keeps a stacked tile's links waiting", () => {
		expect(Arr.map(links, (link) => linkState(cells, link))).toEqual(["road", "rail", "waiting"])
		expect(tally(links, cells)).toMatchObject({ total: 3, roads: 1, rails: 1, waiting: 1 })
	})

	it("reports the share of traffic that goes by road", () => {
		expect(tally(links, cells).roadTraffic).toBeCloseTo(90 / 105)
	})

	it("previews what a move gains: the tile's own links there and the board's change", () => {
		expect(prospect(links, cells, "c", { q: 0, r: 1 })).toEqual(
			Option.some({ roads: 1, rails: 0, gain: 1 }),
		)
		expect(prospect(links, cells, "c", { q: 9, r: 9 })).toEqual(Option.none())
	})

	it("counts what a trade costs the other tile", () => {
		// `a` and `c` trade: a-b stops touching, a-c stays three apart.
		expect(prospect(links, cells, "c", { q: 0, r: 0 })).toEqual(
			Option.some({ roads: 0, rails: 1, gain: -1 }),
		)
	})
})

describe("lakes", () => {
	const ring = (hole: Cell) =>
		board(
			Arr.map(
				Arr.filter(disc(hole, 1), (cell) => cellKey(cell) !== cellKey(hole)),
				(cell, index) => [`tile-${index}`, cell] as const,
			),
		)

	it("floods a cell the land closes in on", () => {
		expect(lakesOf(ring({ q: 0, r: 0 }))).toEqual([{ q: 0, r: 0 }])
	})

	it("gives a coast without a bay one lake, in its most sheltered cell", () => {
		const row = board([
			["a", { q: 0, r: 0 }],
			["b", { q: 1, r: 0 }],
			["c", { q: 2, r: 0 }],
		])
		const lakes = lakesOf(row)
		expect(lakes).toHaveLength(1)
		// Two of the row's tiles touch it, the most any free cell beside a straight row can have.
		expect(
			Arr.filter([...row.values()], (cell) => hexDistance(cell, lakes[0] ?? cell) === 1),
		).toHaveLength(2)
	})

	it("never floods a tile, and drains when a tile is put on the lake", () => {
		const land = ring({ q: 0, r: 0 })
		const built = new Map([...land, ["middle", { q: 0, r: 0 }] as const])
		const taken = new Set(Arr.map([...built.values()], cellKey))
		expect(Arr.filter(lakesOf(built), (cell) => taken.has(cellKey(cell)))).toEqual([])
		expect(lakesOf(built)).not.toContainEqual({ q: 0, r: 0 })
	})

	it("has no water on an empty board, and ignores a tile in hand", () => {
		expect(lakesOf(board([]))).toEqual([])
		expect(lakesOf(board([["a", { q: 0, r: 0 }]]), "a")).toEqual([])
	})

	it("floods at most three bays", () => {
		// Every free cell inside a wide ring of land is closed in on.
		const land = board(
			Arr.map(
				Arr.filter(disc({ q: 0, r: 0 }, 3), (cell) => hexDistance(cell, { q: 0, r: 0 }) % 2 === 1),
				(cell, index) => [`tile-${index}`, cell] as const,
			),
		)
		expect(lakesOf(land).length).toBeLessThanOrEqual(3)
		expect(lakesOf(land).length).toBeGreaterThan(0)
	})
})
