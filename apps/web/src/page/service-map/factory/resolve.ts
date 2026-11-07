import type { BuildingType, ServiceBuilding, WorldCell, WorldEntity, WorldRotation } from "@maple/domain/http"
import { Array as Arr, Option, Order } from "effect"
import type { District, SpatialLayout } from "../../../components/service-map/three/spatial-layout"
import type { Node3D, Vec3 } from "../../../components/service-map/three/types"
import { BUILDINGS, type BuildingNode, defaultBuilding } from "./catalog"
import { type CellKey, cellKey, cellToScene, sceneToCell } from "./grid"
import { buildingCells, cellsFree, nearestFreeCell, type OccupancyWorld } from "./occupancy"

// The world as drawn: the auto layout with the team's placed buildings laid over it. The result
// is a `SpatialLayout`, so `factoryRoutes` and the scene read it unchanged.

export type ResolveNode = BuildingNode & Pick<Node3D, "namespace">

export interface ResolveInput {
	readonly topology: { readonly nodes: ReadonlyArray<ResolveNode> }
	/** The atlas `spatialLayout` for the same topology. */
	readonly auto: SpatialLayout
	/** Stored or optimistic entities; anything other than a building for a known node is ignored. */
	readonly entities: ReadonlyArray<{ readonly entity: WorldEntity }>
}

export interface ResolvedWorld extends SpatialLayout, OccupancyWorld {
	readonly positions: ReadonlyMap<string, Vec3>
	/** The building each node shows: its override, else `defaultBuilding`. */
	readonly buildings: ReadonlyMap<string, BuildingType>
	readonly rotations: ReadonlyMap<string, WorldRotation>
	/** Nodes with a stored entity (placed by hand). */
	readonly placed: ReadonlySet<string>
	/** Auto-placed nodes moved off a placed building's footprint. */
	readonly nudged: ReadonlySet<string>
}

/** The auto layout's district padding around its outermost members (`spatialLayout`, atlas). */
export const DISTRICT_PADDING = { x: (4.2 + 0.7) / 2, z: (4.2 + 1.1) / 2 } as const

/** Code-unit order, never the locale's: every teammate must nudge the same way. */
const byId = Order.String

const isBuilding = (entity: WorldEntity): entity is ServiceBuilding => entity._tag === "ServiceBuilding"

/** Pure: the same input always lays out the same world. */
export const resolveWorld = ({ topology, auto, entities }: ResolveInput): ResolvedWorld => {
	const nodes = Arr.sort(
		topology.nodes,
		Order.mapInput(byId, (node: ResolveNode) => node.id),
	)
	const known = new Set(Arr.map(nodes, (node) => node.id))
	// Entities for nodes outside this topology stay in storage but take no room here.
	const overrides = new Map(
		Arr.flatMap(entities, ({ entity }) =>
			isBuilding(entity) && known.has(entity.nodeId) ? [[entity.nodeId, entity] as const] : [],
		),
	)
	const buildings = new Map(
		Arr.map(
			nodes,
			(node) => [node.id, overrides.get(node.id)?.building ?? defaultBuilding(node)] as const,
		),
	)
	const rotations = new Map(
		Arr.map(nodes, (node): readonly [string, WorldRotation] => [
			node.id,
			overrides.get(node.id)?.rotation ?? 0,
		]),
	)
	const positions = new Map(auto.positions)
	// Local and mutable while resolving; callers only ever see it as `Occupancy`.
	const occupancy = new Map<CellKey, string>()
	const claim = (id: string, cells: ReadonlyArray<WorldCell>) =>
		Arr.forEach(cells, (cell) => occupancy.set(cellKey(cell), id))
	const footprintAt = (id: string, cell: WorldCell) =>
		buildingCells(cell, buildings.get(id) ?? "processor", rotations.get(id) ?? 0)

	Arr.forEach(nodes, (node) => {
		const entity = overrides.get(node.id)
		if (entity === undefined) return
		positions.set(node.id, cellToScene(entity.cell, auto.positions.get(node.id)?.[1] ?? 0))
		claim(node.id, footprintAt(node.id, entity.cell))
	})

	// Auto nodes clear of every placed footprint keep their spot; the rest move to the closest
	// free cell, in id order, so the same edits always nudge the same way.
	const autoNodes = Arr.flatMap(nodes, (node) => {
		const position = auto.positions.get(node.id)
		return overrides.has(node.id) || position === undefined
			? []
			: [{ id: node.id, position, anchor: sceneToCell(position) }]
	})
	const blocked = Arr.filter(
		autoNodes,
		({ id, anchor }) => !cellsFree(occupancy, id, footprintAt(id, anchor)),
	)
	const blockedIds = new Set(Arr.map(blocked, ({ id }) => id))
	Arr.forEach(autoNodes, ({ id, anchor }) => {
		if (!blockedIds.has(id)) claim(id, footprintAt(id, anchor))
	})
	const nudged = new Set<string>()
	Arr.forEach(blocked, ({ id, position, anchor }) => {
		const footprint = BUILDINGS[buildings.get(id) ?? "processor"].footprint
		const free = nearestFreeCell(occupancy, id, anchor, footprint, rotations.get(id) ?? 0)
		// Nowhere free nearby: keep the overlap rather than drop the building.
		const cell = Option.getOrElse(free, () => anchor)
		if (Option.isSome(free)) {
			positions.set(id, cellToScene(cell, position[1]))
			nudged.add(id)
		}
		claim(id, footprintAt(id, cell))
	})

	const placed = new Set(overrides.keys())
	const moved = (id: string) => placed.has(id) || nudged.has(id)
	const districts = Arr.map(auto.districts, (district) =>
		refitDistrict(
			district,
			Arr.filter(nodes, (node) => node.namespace === district.id),
			positions,
			moved,
		),
	)
	return { positions, districts, buildings, rotations, placed, nudged, occupancy }
}

/** A namespace mat grown or shrunk to its members' final spots, padded like the auto layout.
 * Untouched districts (and cascade tiers, which are not namespaces) come back as they were. */
const refitDistrict = (
	district: District,
	members: ReadonlyArray<ResolveNode>,
	positions: ReadonlyMap<string, Vec3>,
	moved: (id: string) => boolean,
): District => {
	if (!Arr.some(members, (node) => moved(node.id))) return district
	const points = Arr.flatMap(members, (node) => {
		const position = positions.get(node.id)
		return position === undefined ? [] : [position]
	})
	if (!Arr.isArrayNonEmpty(points)) return district
	const xs = Arr.map(points, (point) => point[0])
	const zs = Arr.map(points, (point) => point[2])
	const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]
	return {
		...district,
		position: [(minX + maxX) / 2, district.position[1], (minZ + maxZ) / 2],
		width: maxX - minX + DISTRICT_PADDING.x * 2,
		depth: maxZ - minZ + DISTRICT_PADDING.z * 2,
	}
}
