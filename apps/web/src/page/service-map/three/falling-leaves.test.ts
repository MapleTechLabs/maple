import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import type { District } from "../../../components/service-map/three/spatial-layout"
import { groundAt, type LeafWorld, leafPose } from "./falling-leaves"

const FLOOR = -0.14
const world: LeafWorld = {
	sources: [
		{ x: -4, z: 2, top: 1.2, radius: 0.35 },
		{ x: 3, z: -3, top: 1.0, radius: 0.3 },
		{ x: 6, z: 5, top: 1.4, radius: 0.25 },
	],
	districts: [{ id: "zone", label: "zone", position: [0, -0.16, 0], width: 4, depth: 4 }],
	floor: FLOOR,
}

const zoneAt = (x: number): District => ({
	id: `zone${x}`,
	label: "zone",
	position: [x, -0.16, 0],
	width: 4.9,
	depth: 4.9,
})

const LEAVES = Arr.makeBy(36, (i) => i)
const FRAME = 1 / 60
const frames = (seconds: number) => Arr.makeBy(Math.round(seconds / FRAME), (n) => n * FRAME)

describe("leafPose", () => {
	it("never jumps between frames while visible: no leaf pops from the ground back to the crown", () => {
		const jumps = Arr.flatMap(LEAVES, (i) =>
			Arr.flatMap(frames(120), (t) => {
				const a = leafPose(world, i, t)
				const b = leafPose(world, i, t + FRAME)
				if (a.scale === 0 || b.scale === 0) return []
				const step = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
				return step > 0.05 ? [{ i, t, step }] : []
			}),
		)
		expect(jumps).toEqual([])
	})

	it("appears and disappears by growing and shrinking, never at full size", () => {
		const popped = Arr.flatMap(LEAVES, (i) =>
			Arr.flatMap(frames(120), (t) => {
				const a = leafPose(world, i, t).scale
				const b = leafPose(world, i, t + FRAME).scale
				return Math.abs(b - a) > 0.1 ? [{ i, t, from: a, to: b }] : []
			}),
		)
		expect(popped).toEqual([])
	})

	it("comes to rest flat on whatever is under it: a zone's grass or the meadow floor", () => {
		// Trees on the edges of atlas-sized zones, so falls drift across from meadow to grass.
		const edges: LeafWorld = {
			sources: Arr.flatMap([-6, 0, 6], (x) => [
				{ x: x + 2.4, z: 2.2, top: 1.3, radius: 0.35 },
				{ x: x - 2.3, z: -2.4, top: 1.1, radius: 0.3 },
			]),
			districts: Arr.map([-6, 0, 6], zoneAt),
			floor: FLOOR,
		}
		const resting = Arr.flatMap(LEAVES, (i) =>
			Arr.flatMap(frames(120), (t) => {
				const a = leafPose(edges, i, t)
				const b = leafPose(edges, i, t + 0.5)
				const still = a.scale > 0 && a.scale === b.scale && a.x === b.x && a.y === b.y
				return still ? [{ pose: a, ground: groundAt(edges.districts, FLOOR, a.x, a.z) }] : []
			}),
		)
		expect(resting.length).toBeGreaterThan(0)
		expect(Arr.every(resting, ({ pose, ground }) => Math.abs(pose.y - ground) < 1e-9)).toBe(true)
		expect(Arr.every(resting, ({ pose }) => Math.abs(pose.rx + Math.PI / 2) < 1e-9)).toBe(true)
	})

	it("buds at a crown: a leaf's first visible moment is beside one of the trees, up high", () => {
		const budding = Arr.flatMap(LEAVES, (i) =>
			Arr.flatMap(frames(60), (t) => {
				const before = leafPose(world, i, t)
				const now = leafPose(world, i, t + FRAME)
				return before.scale === 0 && now.scale > 0 ? [now] : []
			}),
		)
		expect(budding.length).toBeGreaterThan(0)
		const nearCrown = (leaf: { x: number; y: number; z: number }) =>
			Arr.some(
				world.sources,
				(s) => Math.hypot(leaf.x - s.x, leaf.z - s.z) < s.radius + 0.5 && leaf.y > s.top * 0.6,
			)
		expect(Arr.every(budding, nearCrown)).toBe(true)
	})

	it("with no trees there are no leaves", () => {
		expect(Arr.every(frames(30), (t) => leafPose({ ...world, sources: [] }, 3, t).scale === 0)).toBe(true)
	})
})
