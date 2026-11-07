import { errorRateLevel } from "@maple/ui/lib/error-rate"
import {
	type SpatialLayout,
	spatialLayout,
	type SpatialTopology,
	type SpatialView,
} from "../../components/service-map/three/spatial-layout"
import type { Edge3D, Node3DKind, Topology3D } from "../../components/service-map/three/types"
import type { BuildingType, WorldEntity } from "@maple/domain/http"
import { Schema, Array as Arr, String as Str, Order } from "effect"
import type { OccupancyWorld } from "./factory/occupancy"
import { resolveWorld } from "./factory/resolve"

// The three-free half of the 3D layout (`ServiceMap3DViewport`'s memos), shared by the labels
// in the view and the scene chunk, so both place the same districts and belts.

const LayoutTopology = Schema.Struct({
	nodes: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			namespace: Schema.String,
			kind: Schema.Literals(["edge", "service", "database", "queue", "external"]),
		}),
	),
	edges: Schema.Array(Schema.Struct({ source: Schema.String, target: Schema.String })),
})
export type LayoutTopology = typeof LayoutTopology.Type
const decodeLayoutTopology = Schema.decodeUnknownSync(Schema.fromJsonString(LayoutTopology))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Metrics can refresh without replacing the layout: it is keyed on ids, namespaces and kinds. */
export const topologyKeyOf = (topology: Topology3D): string =>
	encodeJson({
		nodes: Arr.map(topology.nodes, ({ id, namespace, kind }) => ({ id, namespace, kind })).sort((a, b) =>
			Str.localeCompare(b.id)(a.id),
		),
		edges: Arr.map(topology.edges, ({ source, target }) => ({ source, target })).sort((a, b) => {
			const bySource = Str.localeCompare(b.source)(a.source)
			return bySource !== 0 ? bySource : Str.localeCompare(b.target)(a.target)
		}),
	})

/** `JSON.parse(topologyKey)`: the sorted topology the layout and routes are computed from. */
export const layoutTopologyOf = (topologyKey: string): LayoutTopology & SpatialTopology =>
	decodeLayoutTopology(topologyKey)

export interface CustomLayout {
	readonly layout: SpatialLayout
	/** The building each node shows; empty in Cascade, which is never customized. */
	readonly buildings: ReadonlyMap<string, BuildingType>
	/** Where buildings stand, for placement checks; `null` in Cascade. */
	readonly occupancy: OccupancyWorld | null
}

/** The auto layout with the team's placed buildings laid over it. Only Atlas is customized:
 * Cascade's columns are the call depth, so moving a building there would misstate it. */
export const customLayoutOf = (
	topology: Topology3D,
	view: SpatialView,
	entities: ReadonlyArray<WorldEntity>,
): CustomLayout => {
	const auto = spatialLayout(layoutTopologyOf(topologyKeyOf(topology)), view)
	if (view !== "atlas") return { layout: auto, buildings: new Map(), occupancy: null }
	const world = resolveWorld({ topology, auto, entities: Arr.map(entities, (entity) => ({ entity })) })
	return {
		layout: { positions: world.positions, districts: world.districts },
		buildings: world.buildings,
		occupancy: world,
	}
}

export const spatialLayoutOf = (
	topology: Topology3D,
	view: SpatialView,
	entities: ReadonlyArray<WorldEntity> = [],
): SpatialLayout => customLayoutOf(topology, view, entities).layout

export interface LinkLabel {
	readonly id: string
	readonly edge: Edge3D
	readonly prominent: boolean
}

/** `factoryRoutes` + `decorateRoutes` without the curves: each belt's id, edge and prominence. */
export const linkLabels = (topology: Topology3D, layout: SpatialLayout): ReadonlyArray<LinkLabel> => {
	const layoutTopology = layoutTopologyOf(topologyKeyOf(topology))
	type Route = (typeof layoutTopology.edges)[number]
	const layoutNodes: LayoutTopology["nodes"] = layoutTopology.nodes
	const kinds = new Map<string, Node3DKind>(Arr.map(layoutNodes, (node) => [node.id, node.kind] as const))
	const byId = new Map(Arr.map(topology.edges, (edge) => [encodeJson([edge.source, edge.target]), edge]))
	const peak = Math.max(1, ...Arr.map(topology.edges, (edge) => edge.callsPerSecond))
	return Arr.flatMap(
		Arr.sort<Route, Route>(
			layoutTopology.edges,
			Order.combine(
				(a: Route, b: Route) => Str.localeCompare(b.source)(a.source),
				(a: Route, b: Route) => Str.localeCompare(b.target)(a.target),
			),
		),
		(route: Route) => {
			if (!layout.positions.get(route.source) || !layout.positions.get(route.target)) return []
			const edge = byId.get(encodeJson([route.source, route.target]))
			if (!edge) return []
			const conveyor = kinds.get(route.source) === "queue" || kinds.get(route.target) === "queue"
			return [
				{
					id: `link:${encodeJson([route.source, route.target])}`,
					edge,
					prominent:
						!edge.relation &&
						(conveyor ||
							edge.callsPerSecond >= peak * 0.15 ||
							errorRateLevel(edge.errorRate) !== "neutral"),
				},
			]
		},
	)
}
