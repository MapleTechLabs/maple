import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { SERVICE_MAP_3D_TOPOLOGY } from "../../../lab/service-map-3d/fixture"
import type { Node3D } from "../three/types"
import { type Cell, cellKey, hexDistance } from "./hex"
import { init, sync } from "./update"
import { derive, keyedTarget, type SceneInput } from "./world"

const node = (id: string): Node3D => ({
	id,
	label: id,
	kind: "service",
	namespace: "shop",
	platform: "kubernetes",
	throughput: 10,
	errorRate: 0,
})

const HOME: Cell = { q: 0, r: 0 }
const NEXT_DOOR: Cell = { q: 1, r: 0 }

/** Two tiles side by side on the board and a third still in the stack, with `heldId` in hand. */
const holding = (heldId: string | null) => {
	const input: SceneInput = {
		topology: { nodes: Arr.map(["a", "b", "c"], node), edges: [] },
		cells: { a: HOME, b: NEXT_DOOR },
		selectedId: null,
		heldId,
		building: true,
		flowing: false,
		dark: false,
		clock: { hour: 12, day: 80, isSouthern: false },
		muted: true,
		command: { action: "reset", serial: 0 },
	}
	return derive(input, null)
}

describe("moving the held tile with the keyboard", () => {
	it("starts a tile off the stack on a free cell beside the board", () => {
		const derived = holding("c")
		const first = keyedTarget(derived, null, [1, 0])
		expect(Arr.map(derived.targets?.free ?? [], cellKey)).toContain(first === null ? "" : cellKey(first))
	})

	it("steps a lifted tile from its own cell onto the tile beside it", () => {
		expect(keyedTarget(holding("a"), null, [1, 0])).toEqual(NEXT_DOOR)
	})

	it("carries on from the place the tile is over", () => {
		const derived = holding("a")
		const beyond = keyedTarget(derived, NEXT_DOOR, [1, 0])
		expect(beyond).toEqual({ q: 2, r: 0 })
		expect(beyond === null ? 0 : hexDistance(beyond, HOME)).toBe(2)
	})

	it("starts a lifted tile over its own cell when no way is pressed", () => {
		expect(keyedTarget(holding("a"), null, [0, 0])).toEqual(HOME)
	})

	it("has nowhere to go with no tile in hand", () => {
		expect(keyedTarget(holding(null), null, [1, 0])).toBeNull()
	})
})

describe("lifting a tile off the full map", () => {
	const topology = SERVICE_MAP_3D_TOPOLOGY
	const cells = sync(init(), topology).cells
	const lifted = topology.nodes[0]?.id ?? ""
	const scene = (heldId: string | null, previous: ReturnType<typeof derive> | null) =>
		derive(
			{
				topology,
				cells,
				selectedId: null,
				heldId,
				building: true,
				flowing: false,
				dark: false,
				clock: { hour: 12, day: 80, isSouthern: false },
				muted: true,
				command: { action: "reset", serial: 0 },
			},
			previous,
		)

	it("leaves the lakes, the country and the camera's framing where they were", () => {
		const down = scene(null, null)
		const held = scene(lifted, down)
		expect(held.lakes).toEqual(down.lakes)
		expect(held.wilds).toEqual(down.wilds)
		expect(held.centre).toEqual(down.centre)
		expect(held.radius).toBe(down.radius)
	})

	it("offers the tile its own cell back", () => {
		const home = cells[lifted]
		expect(home).toBeDefined()
		expect(Arr.map(scene(lifted, null).targets?.free ?? [], cellKey)).toContain(cellKey(home ?? HOME))
	})
})
