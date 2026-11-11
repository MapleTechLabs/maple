import * as THREE from "three"
import { describe, expect, it } from "vitest"
import { tilePalette } from "./palette"
import { makeTraffic, type Route } from "./traffic"

const route = (linkId: string, kind: Route["kind"], z: number): Route => ({
	linkId,
	kind,
	points: [
		[0, 0, z],
		[10, 0, z],
	],
	count: 1,
	speed: 1,
	color: "white",
	load: "white",
	running: true,
})

/** A ray straight down onto the ground at (x, z), as a click from above would cast. */
const down = (x: number, z: number) => new THREE.Ray(new THREE.Vector3(x, 8, z), new THREE.Vector3(0, -1, 0))

describe("traffic", () => {
	const traffic = () => makeTraffic([route("a>b", "cart", 0), route("c>d", "train", 5)], tilePalette(false))

	it("finds the vehicle the pointer is over, and the link it runs on", () => {
		const fleet = traffic()
		expect(fleet.under(down(0, 0))).toMatchObject({ linkId: "a>b", kind: "cart" })
		expect(fleet.under(down(0, 5))).toMatchObject({ linkId: "c>d", kind: "train" })
	})

	it("finds nothing over empty road", () => {
		expect(traffic().under(down(6, 0))).toBeNull()
		expect(traffic().under(down(0, 2.5))).toBeNull()
	})

	it("moves its vehicles along the route while the traffic runs", () => {
		const fleet = traffic()
		fleet.frame(0.05, true)
		fleet.frame(0.05, true)
		// Two steps of 0.05 s at one unit a second: a tenth of a unit down the road.
		expect(fleet.under(down(0.1, 0))).toMatchObject({ linkId: "a>b" })
		expect(fleet.under(down(1, 0))).toBeNull()
	})

	it("holds them still on a paused map, until one is poked", () => {
		const fleet = traffic()
		expect(fleet.frame(0.05, false)).toBe(false)
		expect(fleet.under(down(0, 0))).toMatchObject({ linkId: "a>b" })
		const cart = fleet.under(down(0, 0))
		fleet.poke(cart?.index ?? -1)
		// A poked cart dashes even though the map is paused, and the frame says it is still playing.
		expect(fleet.frame(0.05, false)).toBe(true)
		fleet.frame(0.05, false)
		fleet.frame(0.05, false)
		fleet.frame(0.05, false)
		expect(fleet.under(down(0, 0))).toBeNull()
	})
})
