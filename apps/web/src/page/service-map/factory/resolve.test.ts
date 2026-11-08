import {
	type BuildingType,
	IsoDateTimeString,
	serviceBuildingId,
	type WorldCell,
	WorldEntityRecord,
	type WorldRotation,
} from "@maple/domain/http"
import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { factoryRoutes } from "../../../components/service-map/three/factory-routing"
import { spatialLayout } from "../../../components/service-map/three/spatial-layout"
import { cellKey, cellToScene, sceneToCell } from "./grid"
import { buildingCells } from "./occupancy"
import { DISTRICT_PADDING, resolveWorld, type ResolveNode } from "./resolve"

const node = (id: string, namespace: string, kind: ResolveNode["kind"] = "service"): ResolveNode => ({
	id,
	namespace,
	kind,
	platform: "unknown",
})

const TOPOLOGY = {
	nodes: [
		node("web", "edge", "edge"),
		node("api", "shop"),
		node("orders", "shop"),
		node("kafka", "queues", "queue"),
		node("pg", "databases", "database"),
	],
	edges: [
		{ source: "web", target: "api" },
		{ source: "api", target: "orders" },
		{ source: "orders", target: "kafka" },
		{ source: "orders", target: "pg" },
	],
}
const AUTO = spatialLayout(TOPOLOGY, "atlas")

const record = (
	nodeId: string,
	cell: WorldCell,
	building: BuildingType | null = null,
	rotation: WorldRotation = 0,
) =>
	new WorldEntityRecord({
		id: serviceBuildingId(nodeId),
		entity: { _tag: "ServiceBuilding", nodeId, cell, rotation, building },
		revision: 1,
		updatedAt: IsoDateTimeString.make("2026-11-07T00:00:00.000Z"),
		updatedBy: null,
	})

const resolve = (entities: ReadonlyArray<WorldEntityRecord>) =>
	resolveWorld({ topology: TOPOLOGY, auto: AUTO, entities })

const autoCell = (id: string) => {
	const position = AUTO.positions.get(id)
	if (position === undefined) return expect.unreachable(`no auto position for ${id}`)
	return sceneToCell(position)
}

describe("resolveWorld", () => {
	test("with nothing placed the world is the auto layout with default buildings", () => {
		const world = resolve([])
		expect([...world.positions]).toEqual([...AUTO.positions])
		expect(world.districts).toEqual(AUTO.districts)
		expect(world.placed.size).toBe(0)
		expect(world.nudged.size).toBe(0)
		expect(world.buildings.get("pg")).toBe("tank")
		expect(world.buildings.get("kafka")).toBe("loader")
		expect(world.buildings.get("web")).toBe("gateway")
	})

	test("a placed building stands on its cell with its chosen type and rotation", () => {
		const world = resolve([record("api", { x: 40, z: -12 }, "shed", 90)])
		expect(world.positions.get("api")).toEqual(cellToScene({ x: 40, z: -12 }))
		expect(world.placed.has("api")).toBe(true)
		expect(world.buildings.get("api")).toBe("shed")
		expect(world.rotations.get("api")).toBe(90)
		// Everyone else stays where the auto layout put them.
		expect(world.positions.get("orders")).toEqual(AUTO.positions.get("orders"))
	})

	test("a placed building with no type override keeps its default", () => {
		const world = resolve([record("pg", { x: 30, z: 30 })])
		expect(world.buildings.get("pg")).toBe("tank")
	})

	test("entities for nodes outside the topology take no room and add no node", () => {
		const world = resolve([record("retired-service", autoCell("api"))])
		expect([...world.positions.keys()].sort()).toEqual([...AUTO.positions.keys()].sort())
		expect(world.placed.size).toBe(0)
		expect(world.nudged.size).toBe(0)
		expect(world.occupancy.get(cellKey(autoCell("api")))).toBe("api")
	})

	test("the refit padding is the padding the auto layout gives its districts", () => {
		Arr.forEach(AUTO.districts, (district) => {
			const members = Arr.flatMap(TOPOLOGY.nodes, (n) => {
				const position = n.namespace === district.id ? AUTO.positions.get(n.id) : undefined
				return position === undefined ? [] : [position]
			})
			const xs = Arr.map(members, (p) => p[0])
			const zs = Arr.map(members, (p) => p[2])
			expect(district.width).toBeCloseTo(Math.max(...xs) - Math.min(...xs) + DISTRICT_PADDING.x * 2)
			expect(district.depth).toBeCloseTo(Math.max(...zs) - Math.min(...zs) + DISTRICT_PADDING.z * 2)
		})
	})

	test("a district refits around its members' final spots with the auto padding", () => {
		const far = { x: 60, z: 0 }
		const world = resolve([record("orders", far)])
		const shop = Arr.findFirst(world.districts, (d) => d.id === "shop")
		if (shop._tag === "None") return expect.unreachable("shop district")
		const api = world.positions.get("api") ?? expect.unreachable("api")
		const orders = cellToScene(far)
		expect(shop.value.width).toBeCloseTo(orders[0] - api[0] + DISTRICT_PADDING.x * 2)
		expect(shop.value.position[0]).toBeCloseTo((orders[0] + api[0]) / 2)
		expect(shop.value.position[2]).toBeCloseTo((orders[2] + api[2]) / 2)
		expect(shop.value.depth).toBeCloseTo(Math.abs(orders[2] - api[2]) + DISTRICT_PADDING.z * 2)
		// Districts nobody touched are exactly the auto ones.
		const untouched = Arr.filter(world.districts, (d) => d.id !== "shop")
		expect(untouched).toEqual(Arr.filter(AUTO.districts, (d) => d.id !== "shop"))
	})

	test("an auto building under a placed one moves to the nearest free cell", () => {
		const world = resolve([record("web", autoCell("pg"))])
		expect(world.nudged).toEqual(new Set(["pg"]))
		const pg = sceneToCell(world.positions.get("pg") ?? expect.unreachable("pg"))
		const webCells = new Set(Arr.map(buildingCells(autoCell("pg"), "gateway"), cellKey))
		expect(Arr.some(buildingCells(pg, "tank"), (cell) => webCells.has(cellKey(cell)))).toBe(false)
		// Clear of the 3x3 gateway, and no further than it has to be.
		const from = autoCell("pg")
		expect(Math.max(Math.abs(pg.x - from.x), Math.abs(pg.z - from.z))).toBe(3)
		// The same edits nudge the same way.
		expect(resolve([record("web", autoCell("pg"))]).positions.get("pg")).toEqual(
			world.positions.get("pg"),
		)
	})

	test("belts route between two buildings moved by hand", () => {
		const world = resolve([record("orders", { x: 50, z: 50 }), record("pg", { x: 50, z: 70 })])
		const route = Arr.findFirst(
			factoryRoutes(TOPOLOGY, world),
			(r) => r.source === "orders" && r.target === "pg",
		)
		if (route._tag === "None") return expect.unreachable("orders -> pg route")
		const start = route.value.curve.getPointAt(0)
		const end = route.value.curve.getPointAt(1)
		const [ox, , oz] = cellToScene({ x: 50, z: 50 })
		const [px, , pz] = cellToScene({ x: 50, z: 70 })
		expect(start.x).toBeCloseTo(ox)
		expect(end.x).toBeCloseTo(px)
		expect(start.z).toBeGreaterThan(oz)
		expect(end.z).toBeLessThan(pz)
	})
})
