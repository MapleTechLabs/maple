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
