import { mapPalette } from "../../../components/service-map/three/appearance"
import type { Edge3D, Node3D, Topology3D } from "../../../components/service-map/three/types"
import * as THREE from "three"
import { describe, expect, it } from "vitest"
import { Array as Arr, Order } from "effect"
import { layoutOf, makeWorld, type WorldInput, type WorldParts } from "./world"

const node = (id: string, throughput = 10): Node3D => ({
	id,
	label: id,
	kind: "service",
	namespace: "",
	platform: "unknown",
	throughput,
	errorRate: 0,
})

const edge = (source: string, target: string): Edge3D => ({
	source,
	target,
	callsPerSecond: 5,
	errorRate: 0,
	avgLatencyMs: 10,
})

const topology: Topology3D = {
	nodes: [node("a"), node("b"), node("c"), node("d")],
	edges: [edge("a", "b"), edge("c", "d")],
}

/** Plain-object parts: each machine a mesh with one frame callback, counted per node. */
const fakeParts = () => {
	const built: Array<string> = []
	const ticks = new Map<string, number>()
	const grounds = { builds: 0 }
	const parts: WorldParts = {
		ground: () => {
			grounds.builds += 1
			return new THREE.Group()
		},
		transport: () => new THREE.Group(),
		machine: (scope, { node: { id }, position }) => {
			built.push(id)
			scope.frames.push(() => ticks.set(id, (ticks.get(id) ?? 0) + 1))
			const machine = new THREE.Group()
			machine.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))
			machine.position.set(...position)
			machine.userData.pickId = id
			return machine
		},
	}
	return { parts, built, ticks, grounds }
}

const layout = layoutOf(topology, "atlas")
const input = (overrides: Partial<WorldInput> = {}): WorldInput => ({
	topology,
	layout,
	view: "atlas",
	selectedId: null,
	palette: mapPalette(false),
	flowing: () => true,
	...overrides,
})

const machines = (world: ReturnType<typeof makeWorld>) =>
	new Map(Arr.map(world.machines.children, (child) => [String(child.userData.pickId), child]))

describe("world reconciliation", () => {
	it("moving the selection rebuilds only machines whose highlight changed", () => {
		const { parts, built } = fakeParts()
		const world = makeWorld(parts)
		world.sync(input({ selectedId: "a" }))
		const before = machines(world)
		built.length = 0
		world.sync(input({ selectedId: "b" }))
		const after = machines(world)
		expect(Arr.sort(built, Order.String)).toEqual(["a", "b"])
		expect(after.get("c")).toBe(before.get("c"))
		expect(after.get("d")).toBe(before.get("d"))
		expect(after.get("a")).not.toBe(before.get("a"))
	})

	it("the ground (worn paths) rebuilds when a belt turns from pipe to conveyor, and only then", () => {
		const { parts, grounds } = fakeParts()
		const world = makeWorld(parts)
		world.sync(input())
		world.sync(input({ selectedId: "a" }))
		expect(grounds.builds).toBe(1)
		const conveyors = {
			...layout,
			links: Arr.map(layout.links, (link) => ({ ...link, kind: "conveyor" as const })),
		}
		world.sync(input({ layout: conveyors }))
		expect(grounds.builds).toBe(2)
	})

	it("a metric change rebuilds only that node's machine", () => {
		const { parts, built } = fakeParts()
		const world = makeWorld(parts)
		world.sync(input())
		const before = machines(world)
		built.length = 0
		const busier = {
			...topology,
			nodes: Arr.map(topology.nodes, (n) => (n.id === "c" ? node("c", 900) : n)),
		}
		world.sync(input({ topology: busier }))
		expect(built).toEqual(["c"])
		expect(machines(world).get("a")).toBe(before.get("a"))
	})

	it("disposes a removed node's geometry and stops its frame callbacks", () => {
		const { parts, ticks } = fakeParts()
		const world = makeWorld(parts)
		world.sync(input())
		const removed = world.machine("d")
		const disposed: Array<string> = []
		removed?.traverse((object) => {
			if (object instanceof THREE.Mesh)
				object.geometry.addEventListener("dispose", () => disposed.push("d"))
		})
		const fewer = { nodes: Arr.filter(topology.nodes, (n) => n.id !== "d"), edges: [edge("a", "b")] }
		world.sync(input({ topology: fewer }))
		world.frame(0.016)
		expect(disposed).toEqual(["d"])
		expect(world.machine("d")).toBeUndefined()
		expect(removed?.parent).toBeNull()
		expect(ticks.get("d")).toBeUndefined()
		expect(ticks.get("a")).toBe(1)
	})

	it("builds the override building instead of the node's default kind", () => {
		const kinds: Array<string> = []
		const parts: WorldParts = {
			...fakeParts().parts,
			machine: (_scope, { building }) => {
				kinds.push(building ?? "default")
				return new THREE.Group()
			},
		}
		const world = makeWorld(parts)
		world.sync(input({ buildings: new Map([["b", "tank"]]) }))
		expect(kinds).toEqual(["default", "tank", "default", "default"])
	})

	it("previews a machine's position without a rebuild and restores it on null", () => {
		const { parts, built } = fakeParts()
		const world = makeWorld(parts)
		world.sync(input())
		const home = world.machine("a")?.position.toArray()
		built.length = 0
		world.previewMachine("a", [40, 0, 40])
		expect(world.machine("a")?.position.toArray()).toEqual([40, 0, 40])
		world.sync(input({ selectedId: "a" }))
		expect(world.machine("a")?.position.toArray()).toEqual([40, 0, 40])
		world.previewMachine("a", null)
		expect(world.machine("a")?.position.toArray()).toEqual(home)
		// Selecting `a` rebuilds it and dims `c` and `d`; neighbour `b` is kept.
		expect(built).toEqual(["a", "c", "d"])
	})
})
