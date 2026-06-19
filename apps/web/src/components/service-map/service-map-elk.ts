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

interface ElkEdgeRoute {
	/** SVG path (absolute coords) through ELK's routed bend points. */
	path: string
	/** Absolute midpoint, for placing the edge label. */
	labelX: number
	labelY: number
}

export interface ElkLayoutResult {
	positions: Map<string, { x: number; y: number }>
	/** Per-edge orthogonal route (by edge id) for node-avoiding edge rendering. */
	routes: Map<string, ElkEdgeRoute>
}

/**
 * Lay the service map out with ELK's layered algorithm. Each namespace becomes a
 * compound container node (so same-namespace services stay together and the
 * dotted boxes never overlap); databases and namespace-less services sit at the
 * top level. `hierarchyHandling: INCLUDE_CHILDREN` + orthogonal edge routing
 * means cross-namespace edges flow with the rest of the graph and route AROUND
 * node cards instead of cutting through them.
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
			"elk.edgeRouting": "ORTHOGONAL",
			"elk.layered.spacing.nodeNodeBetweenLayers": String(
				Math.max(60, config.layerGapX - config.nodeWidth),
			),
			"elk.spacing.nodeNode": String(config.nodeGapY),
			"elk.spacing.edgeNode": String(Math.max(16, Math.round(config.nodeGapY / 2))),
			"elk.layered.spacing.edgeNodeBetweenLayers": String(
				Math.max(16, Math.round(config.nodeGapY / 2)),
			),
			"elk.spacing.componentComponent": String(config.componentGapY),
			// Stable, source-order-aware crossing minimization for deterministic output.
			"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
		},
		children,
		edges: elkEdges,
	}

	const result = await elk.layout(graph)

	const positions = new Map<string, { x: number; y: number }>()
	const routes = new Map<string, ElkEdgeRoute>()

	// Walk the result tree accumulating absolute offsets. Leaf nodes get
	// positions; container nodes are synthetic (skip). Edges carry coordinates
	// relative to the node they're nested under, so apply the same offset.
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
		for (const edge of node.edges ?? []) {
			const section = edge.sections?.[0]
			if (!section) continue
			const pts = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => ({
				x: p.x + offsetX,
				y: p.y + offsetY,
			}))
			routes.set(edge.id, {
				path: roundedPath(pts),
				labelX: pts[Math.floor(pts.length / 2)]!.x,
				labelY: pts[Math.floor(pts.length / 2)]!.y,
			})
		}
	}
	walk(result, 0, 0)

	return { positions, routes }
}

/**
 * Build an SVG path through ELK's orthogonal bend points with small rounded
 * corners (matches the smooth-step look of the non-ELK edges).
 */
function roundedPath(points: Array<{ x: number; y: number }>, radius = 10): string {
	if (points.length === 0) return ""
	if (points.length <= 2) {
		return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")
	}
	let d = `M ${points[0]!.x} ${points[0]!.y}`
	for (let i = 1; i < points.length - 1; i++) {
		const prev = points[i - 1]!
		const curr = points[i]!
		const next = points[i + 1]!
		const r1 = Math.min(radius, dist(prev, curr) / 2)
		const r2 = Math.min(radius, dist(curr, next) / 2)
		const p1 = lerpTo(curr, prev, r1)
		const p2 = lerpTo(curr, next, r2)
		d += ` L ${p1.x} ${p1.y} Q ${curr.x} ${curr.y} ${p2.x} ${p2.y}`
	}
	const last = points[points.length - 1]!
	d += ` L ${last.x} ${last.y}`
	return d
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
	return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Point `d` away from `from` toward `to`. */
function lerpTo(
	from: { x: number; y: number },
	to: { x: number; y: number },
	d: number,
): { x: number; y: number } {
	const len = dist(from, to) || 1
	const t = d / len
	return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
}
