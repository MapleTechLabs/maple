import { errorRateLevel } from "@maple/ui/lib/error-rate"
import {
	type SpatialLayout,
	spatialLayout,
	type SpatialTopology,
	type SpatialView,
} from "../../components/service-map/three/spatial-layout"
import type { Edge3D, Node3DKind, Topology3D } from "../../components/service-map/three/types"
import { Schema } from "effect"

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

/** Metrics can refresh without replacing the layout: it is keyed on ids, namespaces and kinds. */
export const topologyKeyOf = (topology: Topology3D): string =>
	JSON.stringify({
		nodes: topology.nodes
			.map(({ id, namespace, kind }) => ({ id, namespace, kind }))
			.sort((a, b) => a.id.localeCompare(b.id)),
		edges: topology.edges
			.map(({ source, target }) => ({ source, target }))
			.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)),
	})

/** `JSON.parse(topologyKey)`: the sorted topology the layout and routes are computed from. */
export const layoutTopologyOf = (topologyKey: string): LayoutTopology & SpatialTopology =>
	decodeLayoutTopology(topologyKey)

export const spatialLayoutOf = (topology: Topology3D, view: SpatialView): SpatialLayout =>
	spatialLayout(layoutTopologyOf(topologyKeyOf(topology)), view)

export interface LinkLabel {
	readonly id: string
	readonly edge: Edge3D
	readonly prominent: boolean
}

/** `factoryRoutes` + `decorateRoutes` without the curves: each belt's id, edge and prominence. */
export const linkLabels = (topology: Topology3D, layout: SpatialLayout): ReadonlyArray<LinkLabel> => {
	const layoutTopology = layoutTopologyOf(topologyKeyOf(topology))
	const kinds = new Map<string, Node3DKind>(layoutTopology.nodes.map((node) => [node.id, node.kind]))
	const byId = new Map(topology.edges.map((edge) => [JSON.stringify([edge.source, edge.target]), edge]))
	const peak = Math.max(1, ...topology.edges.map((edge) => edge.callsPerSecond))
	return layoutTopology.edges
		.toSorted((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
		.flatMap((route) => {
			if (!layout.positions.get(route.source) || !layout.positions.get(route.target)) return []
			const edge = byId.get(JSON.stringify([route.source, route.target]))
			if (!edge) return []
			const conveyor = kinds.get(route.source) === "queue" || kinds.get(route.target) === "queue"
			return [
				{
					id: `link:${JSON.stringify([route.source, route.target])}`,
					edge,
					prominent:
						!edge.relation &&
						(conveyor ||
							edge.callsPerSecond >= peak * 0.15 ||
							errorRateLevel(edge.errorRate) !== "neutral"),
				},
			]
		})
}
