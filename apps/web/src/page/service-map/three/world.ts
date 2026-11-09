import { Schema, Array as Arr } from "effect"
import {
	type InkPalette,
	type MachineKind,
	sceneryPalette,
} from "../../../components/service-map/three/appearance"
import {
	decorateRoutes,
	type FactoryLink,
	factoryRoutes,
	type RoutingTopology,
} from "../../../components/service-map/three/factory-routing"
import {
	connectedIds,
	type SpatialLayout,
	type SpatialView,
} from "../../../components/service-map/three/spatial-layout"
import type { Topology3D } from "../../../components/service-map/three/types"
import type * as THREE from "three"
import type { WorldEntity } from "@maple/domain/http"
import type { OccupancyWorld } from "../factory/occupancy"
import { customLayoutOf, layoutTopologyOf, topologyKeyOf } from "../scene-layout"
import { scenery } from "./forest"
import { meadowMat, stoneTerrace, terraceSteps, wornPaths } from "./ground"
import { type EntitySpec, entityLayer } from "./entities"
import { type Child, type FrameCallback, group, type Scope, type Vec3 } from "./kit"
import { factoryMachine } from "./machines"
import { factoryTransport } from "./transport"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// The 3D viewport's derived layout, then the scene graph in draw order.

export interface Layout {
	readonly topologyKey: string
	readonly layout: SpatialLayout
	readonly links: ReadonlyArray<FactoryLink>
	/** Building per node from the team's world; a missing id keeps its kind's default. */
	readonly buildings: ReadonlyMap<string, MachineKind>
	readonly occupancy: OccupancyWorld | null
}

export const layoutOf = (
	topology: Topology3D,
	view: SpatialView,
	entities: ReadonlyArray<WorldEntity> = [],
): Layout => {
	const topologyKey = topologyKeyOf(topology)
	const layoutTopology: RoutingTopology = layoutTopologyOf(topologyKey)
	const { layout, buildings, occupancy } = customLayoutOf(topology, view, entities)
	const routes = factoryRoutes(layoutTopology, layout)
	return { topologyKey, layout, links: decorateRoutes(routes, topology.edges), buildings, occupancy }
}

export interface WorldInput {
	readonly topology: Topology3D
	readonly layout: Layout
	readonly view: SpatialView
	readonly selectedId: string | null
	readonly palette: InkPalette
	/** `flowing`: traffic on and motion allowed, read every frame. */
	readonly flowing: () => boolean
	/** Customized building types by node id; a missing id keeps the kind's default. */
	readonly buildings?: ReadonlyMap<string, MachineKind>
}

/** `<Scenery key={view}>` and the forest's own geometry key: rebuilt only when either changes. */
export const sceneryKey = ({ view, layout, palette }: Pick<WorldInput, "view" | "layout" | "palette">) =>
	encodeJson([
		view,
		palette.paper,
		palette.ink,
		Arr.map(layout.layout.districts, (d) => [d.id, d.position, d.width, d.depth]),
		Arr.map(layout.links, (link) => link.geometryKey),
	])

export const sceneryOf = (scope: Scope, input: WorldInput): Child =>
	scenery(scope, {
		layout: input.layout.layout,
		belts: input.layout.links,
		palette: sceneryPalette(input.palette),
		running: input.flowing,
	})

/** Zones and paths or steps, rebuilt together: their key is the districts and route geometry. */
export const groundKey = ({ view, layout }: Pick<WorldInput, "view" | "layout">, paletteKey: string) =>
	encodeJson([
		view,
		paletteKey,
		layout.layout.districts,
		Arr.map(layout.links, (link) => [link.id, link.kind, link.geometryKey]),
	])

/** The builders a world uses; tests swap in plain objects where a part needs a canvas. */
export interface WorldParts {
	readonly ground: (scope: Scope, input: WorldInput) => THREE.Object3D
	readonly transport: typeof factoryTransport
	readonly machine: typeof factoryMachine
}

const groundOf = (scope: Scope, input: WorldInput): THREE.Group => {
	const { view, palette } = input
	const { layout, links } = input.layout
	return group({}, [
		Arr.map(layout.districts, (district) =>
			// Atlas zones are meadow mats; Cascade terraces rise to their depth.
			view === "cascade"
				? stoneTerrace(scope, { district, palette })
				: meadowMat(scope, { district, palette }),
		),
		view === "atlas" && wornPaths(scope, { links, palette }),
		view === "cascade" && terraceSteps(scope, { districts: layout.districts, palette }),
	])
}

export const sceneParts: WorldParts = {
	ground: groundOf,
	transport: factoryTransport,
	machine: factoryMachine,
}

/** One belt per link, keyed by its route, edge metrics and highlight. */
export const transportSpecs = (
	input: WorldInput,
	paletteKey: string,
	parts: WorldParts = sceneParts,
): ReadonlyArray<EntitySpec> => {
	const { selectedId, palette, flowing } = input
	return Arr.map(input.layout.links, (link) => {
		const active = link.edge.source === selectedId || link.edge.target === selectedId
		const dimmed = Boolean(link.edge.dimmed) || (selectedId !== null && !active)
		// `dimmed` already folds in the selection, so the key covers every input of `running`.
		const running = () => flowing() && !dimmed && link.edge.callsPerSecond > 0
		return {
			id: link.id,
			key: encodeJson([
				link.kind,
				link.geometryKey,
				link.edge,
				link.radius,
				link.prominent,
				active,
				dimmed,
				paletteKey,
			]),
			build: (scope) => parts.transport(scope, { link, active, dimmed, palette, running }),
		}
	})
}

export interface MachineSpec extends EntitySpec {
	readonly position: Vec3
}

/** One machine per placed node, keyed by its metrics, place, highlight and building. */
export const machineSpecs = (
	input: WorldInput,
	paletteKey: string,
	parts: WorldParts = sceneParts,
): ReadonlyArray<MachineSpec> => {
	const { topology, view, selectedId, palette, flowing, buildings } = input
	const related = connectedIds(topology, selectedId)
	return Arr.flatMap(topology.nodes, (node) => {
		const position = input.layout.layout.positions.get(node.id)
		if (position === undefined) return []
		const dimmed = Boolean(node.dimmed) || (related !== null && !related.has(node.id))
		const selected = node.id === selectedId
		const building = buildings?.get(node.id)
		return [
			{
				id: node.id,
				position,
				key: encodeJson([node, position, view, dimmed, selected, paletteKey, building ?? null]),
				build: (scope: Scope) =>
					parts.machine(scope, {
						node,
						position,
						view,
						dimmed,
						selected,
						palette,
						running: flowing,
						building,
					}),
			},
		]
	})
}

/** MapScene after `Scenery`: zones, paths or steps, belts, then machines, each kept by key. */
export interface World {
	readonly root: THREE.Group
	/** The pickable machines; each child carries `userData.pickId`. */
	readonly machines: THREE.Group
	readonly sync: (input: WorldInput) => void
	readonly machine: (id: string) => THREE.Object3D | undefined
	/** Moves a built machine without a rebuild; `null` puts it back on its layout position. */
	/** Machines moved by `previewMachine`, where they stand now. */
	readonly previews: () => ReadonlyMap<string, Vec3>
	readonly previewMachine: (id: string, position: Vec3 | null) => void
	readonly frame: FrameCallback
	readonly dispose: () => void
}

export const makeWorld = (parts: WorldParts = sceneParts): World => {
	const ground = entityLayer()
	const transports = entityLayer()
	const machines = entityLayer()
	const root = group({}, [ground.root, transports.root, machines.root])
	const homes = new Map<string, Vec3>()
	const previews = new Map<string, Vec3>()
	const place = (id: string) => {
		const object = machines.get(id)
		const at = previews.get(id) ?? homes.get(id)
		if (object !== undefined && at !== undefined) object.position.set(...at)
	}
	const sync = (input: WorldInput) => {
		const paletteKey = encodeJson(input.palette)
		ground.sync([
			{ id: "ground", key: groundKey(input, paletteKey), build: (scope) => parts.ground(scope, input) },
		])
		transports.sync(transportSpecs(input, paletteKey, parts))
		const specs = machineSpecs(input, paletteKey, parts)
		machines.sync(specs)
		homes.clear()
		Arr.forEach(specs, (spec) => homes.set(spec.id, spec.position))
		Arr.forEach(Arr.fromIterable(previews.keys()), (id) => {
			if (!homes.has(id)) previews.delete(id)
			else place(id)
		})
	}
	return {
		root,
		machines: machines.root,
		sync,
		machine: machines.get,
		previews: () => previews,
		previewMachine: (id, position) => {
			if (position === null) previews.delete(id)
			else previews.set(id, position)
			place(id)
		},
		frame: (delta) => {
			ground.frame(delta)
			transports.frame(delta)
			machines.frame(delta)
		},
		dispose: () => {
			ground.dispose()
			transports.dispose()
			machines.dispose()
			previews.clear()
		},
	}
}
