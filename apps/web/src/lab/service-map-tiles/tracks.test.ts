import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import type { Point } from "./hex"
import { tilePalette } from "./palette"
import { buildRoad, buildTrack } from "./tracks"

const palette = tilePalette(false)
const [FROM, TO]: readonly [Point, Point] = [
	[0, 0],
	[7, 0],
]

/** How far a geometry reaches along each axis. */
const reachOf = (geometry: ReturnType<typeof buildTrack>) => {
	geometry.computeBoundingBox()
	const box = geometry.boundingBox
	return {
		across: box === null ? 0 : box.max.z - box.min.z,
		up: box === null ? 0 : box.max.y,
		points: geometry.getAttribute("position").count,
	}
}

describe("a road", () => {
	const road = (busy: number) => reachOf(buildRoad(FROM, TO, palette, busy).geometry)

	it("is wider the busier its link is", () => {
		const widths = Arr.map([0, 0.4, 1], (busy) => road(busy).across)
		expect(widths).toEqual([...widths].sort((a, b) => a - b))
		expect(road(1).across).toBeGreaterThan(road(0).across + 0.2)
	})

	it("is paved between kerbs when it is busy, and a path of a few stones when it is quiet", () => {
		expect(road(1).points).toBeGreaterThan(road(0.4).points)
		expect(road(0.4).points).toBeGreaterThan(road(0).points)
	})

	it("carries its carts down the same middle line whatever its width", () => {
		expect(buildRoad(FROM, TO, palette, 0).track).toEqual(buildRoad(FROM, TO, palette, 1).track)
	})

	it("looks the same every time it is built", () => {
		expect(road(0.4)).toEqual(road(0.4))
	})
})

describe("a railway", () => {
	it("has telegraph poles beside a long stretch and none beside a short one", () => {
		const long = reachOf(buildTrack([FROM, TO], palette))
		const short = reachOf(buildTrack([FROM, [0.8, 0]], palette))
		expect(long.up).toBeGreaterThan(0.4)
		expect(short.up).toBeLessThan(0.1)
	})
})
