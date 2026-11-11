import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import type { Point } from "./hex"
import { railNetwork } from "./rails"

const span = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

// Three stations round one corner, as three hex sides meet: west, north-east and south-east.
const corner: Point = [0, 0]
const west: Point = [-4, 0]
const northEast: Point = [2, -3.46]
const southEast: Point = [2, 3.46]

describe("railNetwork", () => {
	it("gives each route a line from its first station to its last, through its corners' turns", () => {
		const { paths } = railNetwork([{ id: "a", stops: [west, corner, northEast] }])
		const path = paths.get("a") ?? []
		expect(path[0]).toEqual(west)
		expect(path[path.length - 1]).toEqual(northEast)
		// The turn is rounded: the line passes near the corner without touching it.
		const nearest = Math.min(...Arr.map(path, (point) => span(point, corner)))
		expect(nearest).toBeGreaterThan(0.2)
		expect(nearest).toBeLessThan(1)
	})

	it("lays a side two routes share once, whichever way each runs over it", () => {
		const { pieces } = railNetwork([
			{ id: "a", stops: [west, corner, northEast] },
			{ id: "b", stops: [southEast, corner, west] },
		])
		const shared = Arr.filter(pieces, (piece) => piece.routes.length === 2)
		expect(shared).toHaveLength(1)
		// The shared stretch is the west side; each route also has its own side and its own turn.
		expect(pieces).toHaveLength(5)
		expect(Arr.some(shared[0]?.line ?? [], (point) => span(point, west) < 1e-6)).toBe(true)
	})

	it("puts points where two routes part, on the side they share, facing the corner", () => {
		const { points } = railNetwork([
			{ id: "a", stops: [west, corner, northEast] },
			{ id: "b", stops: [west, corner, southEast] },
		])
		expect(points).toHaveLength(1)
		const [x, z] = points[0]?.at ?? [9, 9]
		expect(z).toBeCloseTo(0)
		expect(x).toBeLessThan(0)
		expect(points[0]?.heading).toBeCloseTo(0)
		expect([...(points[0]?.routes ?? [])].sort()).toEqual(["a", "b"])
	})

	it("has three sets of points where all three ways through a corner are used", () => {
		const { points } = railNetwork([
			{ id: "a", stops: [west, corner, northEast] },
			{ id: "b", stops: [west, corner, southEast] },
			{ id: "c", stops: [northEast, corner, southEast] },
		])
		expect(points).toHaveLength(3)
	})

	it("has no points on a line that never meets another", () => {
		expect(railNetwork([{ id: "a", stops: [west, corner, northEast] }]).points).toEqual([])
	})

	it("ends every line in a station whose track leaves towards the next stop", () => {
		const { stations } = railNetwork([
			{ id: "a", stops: [west, corner, northEast] },
			{ id: "b", stops: [west, corner, southEast] },
		])
		expect(stations).toHaveLength(3)
		const home = Arr.findFirst(stations, (station) => span(station.at, west) < 1e-6)
		expect(home._tag).toBe("Some")
		expect(home._tag === "Some" ? home.value.heading : NaN).toBeCloseTo(0)
		expect(home._tag === "Some" ? [...home.value.routes].sort() : []).toEqual(["a", "b"])
	})

	it("joins two stations with nothing between them by one straight stretch", () => {
		const { pieces, paths } = railNetwork([{ id: "a", stops: [west, northEast] }])
		expect(pieces).toHaveLength(1)
		expect(paths.get("a")).toEqual([west, northEast])
	})
})

describe("railNetwork blocks", () => {
	const lineOf = (network: ReturnType<typeof railNetwork>, id: string): number => {
		const path = network.paths.get(id) ?? []
		return Arr.reduce(Arr.zip(path, Arr.drop(path, 1)), 0, (sum, [a, b]) => sum + span(a, b))
	}

	it("gives a line that meets no other no blocks at all", () => {
		const network = railNetwork([{ id: "a", stops: [west, corner, northEast] }])
		expect(network.blocks.get("a")).toEqual([])
	})

	it("makes one block of a side and the corner after it, in one section for both lines", () => {
		const network = railNetwork([
			{ id: "a", stops: [west, corner, northEast] },
			{ id: "b", stops: [west, corner, southEast] },
		])
		const [a, b] = [network.blocks.get("a") ?? [], network.blocks.get("b") ?? []]
		expect([a.length, b.length]).toEqual([1, 1])
		expect(a[0]?.section).toBe(b[0]?.section)
		// It starts at the shared station and ends where the two lines have parted, short of the far end.
		expect(a[0]?.from).toBe(0)
		expect(a[0]?.to).toBeGreaterThan(3)
		expect(a[0]?.to).toBeLessThan(lineOf(network, "a") - 1)
	})

	it("measures a block along each line's own way, from whichever end it starts", () => {
		const network = railNetwork([
			{ id: "a", stops: [west, corner, northEast] },
			{ id: "b", stops: [southEast, corner, west] },
		])
		const [a, b] = [network.blocks.get("a")?.[0], network.blocks.get("b")?.[0]]
		expect(a?.section).toBe(b?.section)
		// For the line that ends on the shared side, the block runs to the end of its line.
		expect(b?.to).toBeCloseTo(lineOf(network, "b"))
		expect(b?.from).toBeGreaterThan(1)
		expect((a?.to ?? 0) - (a?.from ?? 0)).toBeCloseTo((b?.to ?? 0) - (b?.from ?? 0))
	})

	it("blocks a corner two lines only cross at, though they share no side", () => {
		const east: Point = [4, 0]
		const network = railNetwork([
			{ id: "a", stops: [west, corner, east] },
			{ id: "b", stops: [northEast, corner, southEast] },
		])
		const [a, b] = [network.blocks.get("a") ?? [], network.blocks.get("b") ?? []]
		expect([a.length, b.length]).toEqual([1, 1])
		expect(a[0]?.section).toBe(b[0]?.section)
		// Only the turn through the corner: it begins past the line's own side and is short.
		expect(a[0]?.from).toBeGreaterThan(2)
		expect((a[0]?.to ?? 9) - (a[0]?.from ?? 0)).toBeLessThan(2.5)
	})

	it("keeps two crossings with a private stretch between them in two sections", () => {
		// One line runs west to east through two corners; a different line crosses it at each.
		const [first, second]: [Point, Point] = [
			[0, 0],
			[4, 0],
		]
		const network = railNetwork([
			{ id: "through", stops: [[-4, 0], first, second, [8, 0]] },
			{ id: "north", stops: [[0, -4], first, [0, 4]] },
			{ id: "south", stops: [[4, -4], second, [4, 4]] },
		])
		const through = network.blocks.get("through") ?? []
		expect(through).toHaveLength(2)
		expect(through[0]?.section).not.toBe(through[1]?.section)
		expect(network.blocks.get("north")?.[0]?.section).toBe(through[0]?.section)
		expect(network.blocks.get("south")?.[0]?.section).toBe(through[1]?.section)
		// The two lines that never meet have nothing in common.
		expect(network.blocks.get("north")?.[0]?.section).not.toBe(network.blocks.get("south")?.[0]?.section)
	})
})
