import type { DeclutterResult, DeclutterState } from "@maple/ui/components/service-map/service-map-declutter"
import { applyDeclutter } from "@maple/ui/components/service-map/service-map-declutter"
import type { BuildFlowElementsInput } from "@maple/ui/components/service-map/service-map-utils"
import {
	buildFlowElements,
	DB_NODE_PREFIX,
	DEFAULT_LAYOUT_CONFIG,
	topologyKey,
} from "@maple/ui/components/service-map/service-map-utils"
import { Schema } from "effect"

// The graph `ServiceMapCanvas` derives from warehouse rows (`buildFlowElements`) and the
// declutter stage on top of it. Derived once per input change and cached on the Model.

type FlowNode = ReturnType<typeof buildFlowElements>["nodes"][number]
type FlowEdge = ReturnType<typeof buildFlowElements>["edges"][number]

/** Rows plus the full flow graph built from them. */
export class SourceGraph {
	constructor(
		readonly rawNodes: ReadonlyArray<FlowNode>,
		readonly flowEdges: ReadonlyArray<FlowEdge>,
		/** Focusable, legend-listed service ids (no db nodes), sorted. */
		readonly services: ReadonlyArray<string>,
	) {}
}
export const SourceGraphSchema = Schema.instanceOf(SourceGraph)

export const buildSourceGraph = (input: BuildFlowElementsInput): SourceGraph => {
	const { nodes, edges } = buildFlowElements(input)
	const services = Array.from(
		new Set(nodes.filter((n) => !n.id.startsWith(DB_NODE_PREFIX)).map((n) => n.id)),
	).toSorted()
	return new SourceGraph(nodes, edges, services)
}

/** The effective graph after declutter, with the layout signature it keys ELK on. */
export class EffectiveGraph {
	constructor(
		readonly declutter: DeclutterResult,
		/** `topology|namespaces|config|engine`; positions and fits are tied to it. */
		readonly signature: string,
	) {}
	get nodes(): ReadonlyArray<FlowNode> {
		return this.declutter.nodes
	}
	get edges(): ReadonlyArray<FlowEdge> {
		return this.declutter.edges
	}
}
export const EffectiveGraphSchema = Schema.instanceOf(EffectiveGraph)

export const declutterGraph = (
	source: SourceGraph,
	state: DeclutterState,
	exemptIds: ReadonlySet<string>,
): EffectiveGraph => {
	const declutter = applyDeclutter([...source.rawNodes], [...source.flowEdges], state, exemptIds)
	const nsKey = declutter.nodes
		.flatMap((node) => (node.data.namespace ? [`${node.id}=${node.data.namespace}`] : []))
		.sort()
		.join(",")
	const signature = `${topologyKey(declutter.nodes, declutter.edges)}|${nsKey}|${JSON.stringify(DEFAULT_LAYOUT_CONFIG)}|elk3`
	return new EffectiveGraph(declutter, signature)
}

export type { FlowEdge, FlowNode }
