import type { Edge, Node } from "@xyflow/react"
import type { ElkExtendedEdge, ElkNode, ELK } from "elkjs/lib/elk-api"
import {
	NS_LABEL_HEIGHT,
	NS_PADDING_X,
	NS_PADDING_Y,
	nodeNamespace,
	type LayoutConfig,
	type ServiceEdgeData,
	type ServiceNodeData,
} from "./service-map-utils"

// Lazily construct a single ELK instance. The bundled build runs the layout on
// the main thread (async API, no worker-URL plumbing) and is only pulled into
// the bundle the first time a namespaced service map is laid out.
let elkInstance: Promise<ELK> | null = null
function getElk(): Promise<ELK> {
	if (!elkInstance) {
		elkInstance = import("elkjs/lib/elk.bundled.js").then((m) => new m.default())
	}
	return elkInstance
}

const ELK_CONTAINER_PREFIX = "elkns:"

export interface ElkLayoutResult {
	positions: Map<string, { x: number; y: number }>
}

/**
 * Lay the service map out with ELK's layered algorithm. Each namespace becomes a
 * compound container node (so same-namespace services stay together and the
 * dotted boxes never overlap); databases and namespace-less services sit at the
 * top level. `hierarchyHandling: INCLUDE_CHILDREN` keeps cross-namespace edges
 * flowing left→right with the rest of the graph.
 *
 * Only node POSITIONS are returned — edges are rendered as ReactFlow smooth-step
 * curves (matching the non-namespaced flat layout). ELK's own orthogonal edge
 * routing is intentionally not used: it turned long cross-namespace edges into a
 * sprawl of rectangular detours.
 *
 * Deterministic: ELK layered uses no randomness, so the same topology yields the
 * same layout (callers memoize on a topology key).
 */
export async function layoutServiceMapWithElk(
	nodes: Node<ServiceNodeData>[],
	edges: Edge<ServiceEdgeData>[],
	config: LayoutConfig,
): Promise<ElkLayoutResult> {
	const elk = await getElk()

	const lanes = new Map<string, Node<ServiceNodeData>[]>()
	const topLevel: Node<ServiceNodeData>[] = []
	for (const node of nodes) {
		const ns = nodeNamespace(node)
		if (ns === undefined) {
			topLevel.push(node)
			continue
		}
		const lane = lanes.get(ns)
		if (lane) lane.push(node)
		else lanes.set(ns, [node])
	}

	const toElkNode = (node: Node<ServiceNodeData>): ElkNode => ({
		id: node.id,
		width: config.nodeWidth,
		height: config.nodeHeight,
	})

	const children: ElkNode[] = []
	for (const ns of Array.from(lanes.keys()).sort()) {
		children.push({
			id: `${ELK_CONTAINER_PREFIX}${ns}`,
			children: lanes.get(ns)!.map(toElkNode),
			layoutOptions: {
				// Reserve room at the top for the namespace label chip.
				"elk.padding": `[top=${NS_LABEL_HEIGHT + NS_PADDING_Y},left=${NS_PADDING_X},bottom=${NS_PADDING_Y},right=${NS_PADDING_X}]`,
			},
		})
	}
	for (const node of topLevel) children.push(toElkNode(node))

	const elkEdges: ElkExtendedEdge[] = edges.map((edge) => ({
		id: edge.id,
		sources: [edge.source],
		targets: [edge.target],
	}))

	const graph: ElkNode = {
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "RIGHT",
			"elk.hierarchyHandling": "INCLUDE_CHILDREN",
			// Edges are rendered as smooth-step curves by ReactFlow (matching the
			// non-namespaced flat layout), not from ELK routes — so use POLYLINE here,
			// which reserves far less inter-node space than ORTHOGONAL and keeps the
			// graph compact instead of sprawling into long rectangular detours.
			"elk.edgeRouting": "POLYLINE",
			// Tighter layer gap: ORTHOGONAL routing needed wide channels; with curved
			// edges we can pack columns much closer.
			"elk.layered.spacing.nodeNodeBetweenLayers": String(
				Math.max(70, Math.round((config.layerGapX - config.nodeWidth) * 0.6)),
			),
			"elk.spacing.nodeNode": String(config.nodeGapY),
			"elk.spacing.edgeNode": "12",
			"elk.layered.spacing.edgeNodeBetweenLayers": "12",
			// Pack namespace containers close together.
			"elk.spacing.componentComponent": String(Math.round(config.componentGapY * 0.6)),
			// Network-simplex node placement compacts the graph vertically (less
			// wasted whitespace between rows than the default).
			"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
			// Stable, source-order-aware crossing minimization for deterministic output.
			"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
		},
		children,
		edges: elkEdges,
	}

	const result = await elk.layout(graph)

	const positions = new Map<string, { x: number; y: number }>()

	// Walk the result tree accumulating absolute offsets. Leaf nodes get
	// positions; container nodes are synthetic (recurse into them).
	const walk = (node: ElkNode, offsetX: number, offsetY: number) => {
		for (const child of node.children ?? []) {
			const ax = offsetX + (child.x ?? 0)
			const ay = offsetY + (child.y ?? 0)
			if (child.children && child.children.length > 0) {
				walk(child, ax, ay)
			} else {
				positions.set(child.id, { x: ax, y: ay })
			}
		}
	}
	walk(result, 0, 0)

	return { positions }
}
