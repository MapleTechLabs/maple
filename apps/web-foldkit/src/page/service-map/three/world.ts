import type { InkPalette } from "../../../components/service-map/three/appearance"
import {
	decorateRoutes,
	type FactoryLink,
	factoryRoutes,
	type RoutingTopology,
} from "../../../components/service-map/three/factory-routing"
import {
	connectedIds,
	type SpatialLayout,
	spatialLayout,
	type SpatialTopology,
	type SpatialView,
} from "../../../components/service-map/three/spatial-layout"
import type { Topology3D } from "../../../components/service-map/three/types"
import type * as THREE from "three"
import { layoutTopologyOf, topologyKeyOf } from "../scene-layout"
import { scenery } from "./forest"
import { meadowMat, stoneTerrace, terraceSteps, wornPaths } from "./ground"
import { type Child, group, type Scope } from "./kit"
import { factoryMachine } from "./machines"
import { factoryTransport } from "./transport"

// The 3D viewport's derived layout, then the scene graph in draw order.

export interface Layout {
	readonly topologyKey: string
	readonly layout: SpatialLayout
	readonly links: ReadonlyArray<FactoryLink>
}

export const layoutOf = (topology: Topology3D, view: SpatialView): Layout => {
	const topologyKey = topologyKeyOf(topology)
	const layoutTopology: SpatialTopology & RoutingTopology = layoutTopologyOf(topologyKey)
	const layout = spatialLayout(layoutTopology, view)
	const routes = factoryRoutes(layoutTopology, layout)
	return { topologyKey, layout, links: decorateRoutes(routes, topology.edges) }
}

export interface WorldInput {
	readonly topology: Topology3D
	readonly layout: Layout
	readonly view: SpatialView
	readonly selectedId: string | null
	readonly palette: InkPalette
	/** `flowing`: traffic on and motion allowed, read every frame. */
	readonly flowing: () => boolean
}

/** `<Scenery key={view}>` and the forest's own geometry key: rebuilt only when either changes. */
export const sceneryKey = ({ view, layout, palette }: Pick<WorldInput, "view" | "layout" | "palette">) =>
	JSON.stringify([
		view,
		palette.paper,
		palette.ink,
		layout.layout.districts.map((d) => [d.id, d.position, d.width, d.depth]),
		layout.links.map((link) => link.geometryKey),
	])

export const sceneryOf = (scope: Scope, input: WorldInput): Child =>
	scenery(scope, {
		layout: input.layout.layout,
		belts: input.layout.links,
		palette: input.palette,
		running: input.flowing,
	})

/** MapScene after `Scenery`: zones, paths or steps, belts, then machines. */
export const worldOf = (scope: Scope, input: WorldInput): THREE.Group => {
	const { topology, view, selectedId, palette, flowing } = input
	const { layout, links } = input.layout
	const related = connectedIds(topology, selectedId)
	return group({}, [
		layout.districts.map((district) =>
			// Atlas zones are meadow mats; Cascade terraces rise to their depth.
			view === "cascade"
				? stoneTerrace(scope, { district, palette })
				: meadowMat(scope, { district, palette }),
		),
		view === "atlas" && wornPaths(scope, { links, palette }),
		view === "cascade" && terraceSteps(scope, { districts: layout.districts, palette }),
		links.map((link) => {
			const active = link.edge.source === selectedId || link.edge.target === selectedId
			return factoryTransport(scope, {
				link,
				active,
				dimmed: Boolean(link.edge.dimmed) || (selectedId !== null && !active),
				palette,
				running: () =>
					flowing() &&
					!link.edge.dimmed &&
					link.edge.callsPerSecond > 0 &&
					(selectedId === null || active),
			})
		}),
		topology.nodes.map((node) => {
			const position = layout.positions.get(node.id)
			return (
				position &&
				factoryMachine(scope, {
					node,
					position,
					view,
					dimmed: Boolean(node.dimmed) || (related !== null && !related.has(node.id)),
					selected: node.id === selectedId,
					palette,
					running: flowing,
				})
			)
		}),
	])
}
