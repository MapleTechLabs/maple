import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { type Cell, cellToPoint, disc, HEX_SIZE, type Point } from "./hex"
import { bordersOf, laneBetween } from "./lanes"

const span = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

describe("railway lanes", () => {
	const origin: Cell = { q: 0, r: 0 }
	const land = disc(origin, 5)
	const borders = bordersOf(land)

	it("runs from one tile's centre to the other's", () => {
		const lane = laneBetween(borders, { q: -2, r: 0 }, { q: 2, r: 1 })
		expect(lane[0]).toEqual(cellToPoint({ q: -2, r: 0 }))
		expect(lane[lane.length - 1]).toEqual(cellToPoint({ q: 2, r: 1 }))
	})

	it("follows tile sides between the two tiles: every step in between is one side long", () => {
		const lane = laneBetween(borders, { q: -2, r: 0 }, { q: 2, r: 1 })
		const track = lane.slice(1, -1)
		const steps = Arr.map(Arr.zip(track, Arr.drop(track, 1)), ([a, b]) => span(a, b))
		expect(steps.length).toBeGreaterThan(2)
		Arr.forEach(steps, (step) => expect(step).toBeCloseTo(HEX_SIZE))
	})

	it("never cuts through a tile: the track stays a full corner radius from every tile centre", () => {
		const lane = laneBetween(borders, { q: -3, r: 1 }, { q: 3, r: -2 }).slice(1, -1)
		const nearest = Math.min(
			...Arr.flatMap(land, (cell) => Arr.map(lane, (point) => span(point, cellToPoint(cell)))),
		)
		expect(nearest).toBeCloseTo(HEX_SIZE)
	})

	it("goes round a gap in the land instead of across it", () => {
		// A ring of tiles with a hole in the middle: the two ends face each other across the hole.
		const ring = Arr.filter(disc(origin, 2), (cell) => !(cell.q === 0 && cell.r === 0))
		const lane = laneBetween(bordersOf(ring), { q: -2, r: 0 }, { q: 2, r: 0 }).slice(1, -1)
		const corners = new Set(
			Arr.flatMap(ring, (cell) =>
				Arr.map(Arr.range(0, 5), (index) => {
					const [x, z] = cellToPoint(cell)
					const angle = (Math.PI / 180) * (60 * index - 30)
					return `${Math.round((x + HEX_SIZE * Math.cos(angle)) * 100)},${Math.round((z + HEX_SIZE * Math.sin(angle)) * 100)}`
				}),
			),
		)
		expect(lane.length).toBeGreaterThan(2)
		expect(
			Arr.every(lane, ([x, z]) => corners.has(`${Math.round(x * 100)},${Math.round(z * 100)}`)),
		).toBe(true)
	})

	it("crosses open country along cell sides when no land joins the two tiles", () => {
		// Two landmasses, with a third tile standing alone between them.
		const far: Cell = { q: 6, r: 0 }
		const between: Cell = { q: 3, r: 0 }
		const lane = laneBetween(bordersOf([origin, between, far]), origin, far)
		expect(lane[0]).toEqual(cellToPoint(origin))
		expect(lane[lane.length - 1]).toEqual(cellToPoint(far))
		const track = lane.slice(1, -1)
		expect(track.length).toBeGreaterThan(2)
		// It goes round the tile in its way: never nearer its middle than a corner is.
		const nearest = Math.min(...Arr.map(track, (point) => span(point, cellToPoint(between))))
		expect(nearest).toBeGreaterThanOrEqual(HEX_SIZE - 1e-6)
	})
})
