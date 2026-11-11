import { Array as Arr } from "effect"
import * as THREE from "three"
import { describe, expect, it } from "vitest"
import { tilePalette } from "./palette"
import { COUPLING, homeOf } from "./signalling"
import { makeTraffic, type Route } from "./traffic"

const route = (linkId: string, kind: Route["kind"], z: number, count = 1): Route => ({
	linkId,
	kind,
	points: [
		[0, 0, z],
		[10, 0, z],
	],
	count,
	speed: 1,
	color: "white",
	load: "white",
	running: true,
})

/** A ray straight down onto the ground at (x, z), as a click from above would cast. */
const down = (x: number, z: number) => new THREE.Ray(new THREE.Vector3(x, 8, z), new THREE.Vector3(0, -1, 0))

/** Where along x a vehicle of `linkId` is, if one is anywhere on the row `z`. */
const whereOn = (fleet: ReturnType<typeof makeTraffic>, linkId: string, z: number): ReadonlyArray<number> =>
	Arr.filter(
		Arr.makeBy(111, (index) => index / 10),
		(x) => fleet.under(down(x, z))?.linkId === linkId,
	)

const runFor = (fleet: ReturnType<typeof makeTraffic>, seconds: number) =>
	Arr.forEach(Arr.range(1, Math.round(seconds / 0.05)), () => fleet.frame(0.05, true))

describe("traffic", () => {
	const traffic = () => makeTraffic([route("a>b", "cart", 0), route("c>d", "train", 5)], tilePalette(false))

	it("finds the vehicle the pointer is over, and the link it runs on", () => {
		const fleet = traffic()
		expect(fleet.under(down(0, 0))).toMatchObject({ linkId: "a>b", kind: "cart" })
		// A train waits with its wagon clear of the buffer, so the engine stands a little way out.
		const home = homeOf({ length: 10, wagons: 1, speed: 1, blocks: [] })
		expect(fleet.under(down(home, 5))).toMatchObject({ linkId: "c>d", kind: "train" })
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
		Arr.forEach(Arr.range(1, 3), () => fleet.frame(0.05, false))
		expect(fleet.under(down(0, 0))).toBeNull()
	})
})

describe("a round trip", () => {
	it("keeps a cart on its road the whole way round: out, about and back, never gone", () => {
		const fleet = makeTraffic([route("a>b", "cart", 0)], tilePalette(false))
		// The round is a little over twenty units at one unit a second: sample past a full lap.
		const seen = Arr.map(Arr.range(0, 23), () => {
			const at = whereOn(fleet, "a>b", 0)
			runFor(fleet, 1)
			return at
		})
		expect(Arr.every(seen, (at) => at.length > 0)).toBe(true)
		const farthest = Math.max(...Arr.flatMap(seen, (at) => [...at]))
		expect(farthest).toBeGreaterThan(9.5)
		// It is back where it started after a lap, without jumping there.
		const steps = Arr.map(Arr.zip(seen, Arr.drop(seen, 1)), ([before, after]) =>
			Math.abs((before[0] ?? 0) - (after[0] ?? 0)),
		)
		expect(Math.max(...steps)).toBeLessThan(1.5)
	})

	it("runs a train to the far station and back again in reverse, never gone", () => {
		const fleet = makeTraffic([route("c>d", "train", 5)], tilePalette(false))
		const atBuffer = { ever: false }
		// Out, a stand at the far station and home again takes about twenty-five seconds.
		const noses = Arr.map(Arr.range(0, 30), () => {
			const at = whereOn(fleet, "c>d", 5)
			// The far end is looked at four times a second: the engine stands there under two.
			Arr.forEach(Arr.range(1, 4), () => {
				atBuffer.ever = atBuffer.ever || fleet.under(down(10, 5)) !== null
				runFor(fleet, 0.25)
			})
			return Math.max(...at, -1)
		})
		expect(Arr.every(noses, (nose) => nose >= 0)).toBe(true)
		// It pulls up short of the far buffer instead of running into it.
		expect(atBuffer.ever).toBe(false)
		const turned = noses.indexOf(Math.max(...noses))
		expect(Math.max(...noses)).toBeGreaterThan(9.5)
		// After the far station it comes home, and it never jumps: it tops out at a unit a second.
		expect(Math.min(...Arr.drop(noses, turned))).toBeLessThan(2.5)
		const steps = Arr.map(Arr.zip(noses, Arr.drop(noses, 1)), ([before, after]) =>
			Math.abs(before - after),
		)
		expect(Math.max(...steps)).toBeLessThan(1.5)
	})

	it("keeps its trains where they are when only the selection changes", () => {
		const fleet = makeTraffic([route("c>d", "train", 5)], tilePalette(false))
		runFor(fleet, 6)
		const before = whereOn(fleet, "c>d", 5)
		fleet.setRunning(() => false)
		fleet.frame(0.05, true)
		expect(Math.abs(Math.max(...whereOn(fleet, "c>d", 5)) - Math.max(...before))).toBeLessThan(0.2)
	})

	it("holds one train at its signal while another is on the track they share", () => {
		const shared = [{ section: "middle", from: 4, to: 7 }]
		const fleet = makeTraffic(
			[
				{ ...route("a>b", "train", 5), blocks: shared },
				{ ...route("c>d", "train", 8), blocks: shared },
			],
			tilePalette(false),
		)
		/** Whether a train of `linkId` has any part of itself between x = 4 and x = 7 on row `z`. */
		const onShared = (linkId: string, z: number) =>
			Arr.some(whereOn(fleet, linkId, z), (x) => x > 4.4 && x < 6.6)
		const seen = { together: false, first: false, second: false }
		Arr.forEach(Arr.range(1, 240), () => {
			const [first, second] = [onShared("a>b", 5), onShared("c>d", 8)]
			seen.together = seen.together || (first && second)
			seen.first = seen.first || first
			seen.second = seen.second || second
			runFor(fleet, 0.25)
		})
		expect(seen).toEqual({ together: false, first: true, second: true })
	})

	it("pulls a longer train on a busier link, and waits further out for it", () => {
		const fleet = makeTraffic([route("c>d", "train", 5, 3)], tilePalette(false))
		const at = whereOn(fleet, "c>d", 5)
		// Engine and three wagons span three couplings.
		expect(Math.max(...at) - Math.min(...at)).toBeGreaterThan(COUPLING * 3 - 0.1)
	})

	it("leaves a line too short for its train without one", () => {
		const short: Route = {
			...route("c>d", "train", 5, 3),
			points: [
				[0, 0, 5],
				[1, 0, 5],
			],
		}
		expect(whereOn(makeTraffic([short], tilePalette(false)), "c>d", 5)).toEqual([])
	})
})
