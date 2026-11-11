import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import type { Link } from "./board"
import { type Cell, cellToPoint, HEX_SIZE, type Point } from "./hex"
import { networkOf, STATION_DISTANCE } from "./network"

const link = (source: string, target: string): Link => ({
	id: `${source}>${target}`,
	source,
	target,
	callsPerSecond: 10,
	errorRate: 0,
	dimmed: false,
})

const span = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

const cells = new Map<string, Cell>([
	["a", { q: 0, r: 0 }],
	["b", { q: 1, r: 0 }],
	["c", { q: 2, r: 0 }],
])
const links = [link("a", "b"), link("b", "c"), link("a", "c")]

describe("networkOf", () => {
	it("lays a road between touching tiles, centre to centre, and a railway between the rest", () => {
		const network = networkOf(links, cells, null)
		expect(Arr.map(network.roads, (road) => [road.link.id, road.from, road.to])).toEqual([
			["a>b", cellToPoint({ q: 0, r: 0 }), cellToPoint({ q: 1, r: 0 })],
			["b>c", cellToPoint({ q: 1, r: 0 }), cellToPoint({ q: 2, r: 0 })],
		])
		expect(Arr.map(network.rails, (rail) => rail.link.id)).toEqual(["a>c"])
	})

	it("starts and ends a railway at a station beside each village, with tile corners between", () => {
		const points = networkOf(links, cells, null).rails[0]?.points ?? []
		expect(span(points[0] ?? [9, 9], cellToPoint({ q: 0, r: 0 }))).toBeCloseTo(STATION_DISTANCE)
		expect(span(points[points.length - 1] ?? [9, 9], cellToPoint({ q: 2, r: 0 }))).toBeCloseTo(
			STATION_DISTANCE,
		)
		const track = points.slice(1, -1)
		expect(track.length).toBeGreaterThan(1)
		// Every corner on the way is a corner of the tile in the middle.
		Arr.forEach(track, (point) => expect(span(point, cellToPoint({ q: 1, r: 0 }))).toBeCloseTo(HEX_SIZE))
	})

	it("tells each tile which ways its roads and railways leave", () => {
		const { corridors } = networkOf(links, cells, null)
		// `b` has a road east and a road west; `a` has its road east and a track to a corner.
		expect(Arr.map(corridors.get("b") ?? [], (angle) => Math.round((angle * 180) / Math.PI))).toEqual([
			180, 0,
		])
		const [road, rail] = corridors.get("a") ?? []
		expect(road).toBeCloseTo(0)
		expect(Math.abs(Math.round(((rail ?? 0) * 180) / Math.PI))).toBe(30)
	})

	it("leaves a tile in hand out, with every link that touches it", () => {
		const network = networkOf(links, cells, "b")
		expect(network.roads).toEqual([])
		expect(Arr.map(network.rails, (rail) => rail.link.id)).toEqual(["a>c"])
		expect(network.corridors.has("b")).toBe(false)
	})
})

describe("railways and lakes", () => {
	it("lets a railway run along a lake's shore between two tiles the land does not join", () => {
		const apart = new Map<string, Cell>([
			["a", { q: 0, r: 0 }],
			["c", { q: 2, r: 0 }],
		])
		const round = networkOf([link("a", "c")], apart, null, [{ q: 1, r: 0 }]).rails[0]?.points ?? []
		const shore = round.slice(1, -1)
		// Every point between the two stations is a corner of the lake's cell.
		expect(shore.length).toBeGreaterThan(1)
		Arr.forEach(shore, (point) => expect(span(point, cellToPoint({ q: 1, r: 0 }))).toBeCloseTo(HEX_SIZE))
	})
})

describe("stations", () => {
	it("gives each line of a tile a station corner of its own", () => {
		// Two lines leave the same tile for two tiles that both lie to its east.
		const land = new Map<string, Cell>([
			["hub", { q: 0, r: 0 }],
			["near", { q: 1, r: 0 }],
			["upper", { q: 1, r: -1 }],
			["east", { q: 2, r: 0 }],
			["north-east", { q: 2, r: -1 }],
		])
		const { rails } = networkOf([link("hub", "east"), link("hub", "north-east")], land, null)
		const nowhere: Point = [9, 9]
		const stations = Arr.map(rails, (rail): Point => rail.points[0] ?? nowhere)
		expect(stations).toHaveLength(2)
		expect(span(stations[0] ?? nowhere, stations[1] ?? nowhere)).toBeGreaterThan(0.5)
		// Both still stand beside the hub's village.
		Arr.forEach(stations, (station) =>
			expect(span(station, cellToPoint({ q: 0, r: 0 }))).toBeCloseTo(STATION_DISTANCE),
		)
	})
})
