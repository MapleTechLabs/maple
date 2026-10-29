import { getServiceMapNodeColor } from "@maple/ui/components/service-map/service-map-utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { handlePoint, type MeasuredNode } from "../xyflow/geometry"
import { edgesLayer, flowEdge, flowNode, nodesLayer } from "../xyflow/view"
import { edgeGeometry, serviceMapEdge } from "./edge"
import type { EffectiveGraph, FlowNode } from "./graph"
import { namespaceBoxes } from "./namespace-group"
import { serviceMapNode } from "./nodes"
import { type MiniMapNode, miniMapRects } from "./panels"
import { type AnimateParticlesRequirement, particleCanvas } from "./particles"
import { Message, type Positions, positionOf } from "./service-map"

// The node, edge, minimap and particle layers. Each depends on the graph, layout, measurements
// and selection only, never on the camera, so the view memoizes them across pan and zoom.

type Measured = Readonly<Record<string, MeasuredNode>>
type ColorMode = "service" | "health" | "platform"

const nodeData = (
	graph: EffectiveGraph,
	node: FlowNode,
	selectedId: Option.Option<string>,
	colorMode: ColorMode,
) => ({
	...node.data,
	selected: Option.contains(selectedId, node.id),
	colorMode,
	dimmed: graph.declutter.dimmedNodeIds.has(node.id),
})

export const renderNodes = <M>(
	h: HtmlBuilder<M>,
	graph: EffectiveGraph,
	positions: Positions,
	measured: Measured,
	selectedId: Option.Option<string>,
	colorMode: ColorMode,
	toMessage: (message: Message) => M,
	draggingId: string | null,
): Html =>
	nodesLayer(h, [
		...namespaceBoxes(h, graph, positions, measured, (namespace) =>
			toMessage(Message.ClickedCollapseNamespace({ namespace })),
		),
		...graph.nodes.map((node) =>
			flowNode(h, {
				id: node.id,
				type: "serviceNode",
				className: node.id === draggingId ? "nopan draggable dragging" : "nopan draggable",
				position: positionOf(positions, node),
				measured: measured[node.id] !== undefined,
				onClick: toMessage(Message.ClickedNode({ nodeId: node.id })),
				children: [serviceMapNode(h, node.id, nodeData(graph, node, selectedId, colorMode))],
			}),
		),
	])

/** Each drawable edge with its endpoints, in render order. */
const drawableEdges = (graph: EffectiveGraph, positions: Positions, measured: Measured) =>
	graph.edges.flatMap((edge, index) => {
		const sourceMeasured = measured[edge.source]
		const targetMeasured = measured[edge.target]
		const sourceHandle = sourceMeasured?.handles.find((handle) => handle.type === "source")
		const targetHandle = targetMeasured?.handles.find((handle) => handle.type === "target")
		if (sourceHandle === undefined || targetHandle === undefined) return []
		const at = (id: string, m: MeasuredNode) => ({
			id,
			position: positions[id] ?? { x: 0, y: 0 },
			measured: m,
		})
		const data =
			edge.data && graph.declutter.dimmedEdgeIds.has(edge.id)
				? { ...edge.data, dimmed: true }
				: edge.data
		return [
			{
				edge: { ...edge, data },
				index,
				source: handlePoint(at(edge.source, sourceMeasured), sourceHandle),
				target: handlePoint(at(edge.target, targetMeasured), targetHandle),
			},
		]
	})

export const renderEdges = <M>(
	h: HtmlBuilder<M>,
	graph: EffectiveGraph,
	positions: Positions,
	measured: Measured,
): Html =>
	edgesLayer(
		h,
		drawableEdges(graph, positions, measured).map(({ edge, index, source, target }) =>
			flowEdge(h, {
				id: edge.id,
				type: "serviceEdge",
				source: edge.source,
				target: edge.target,
				children: serviceMapEdge(h, edge, source, target, index),
			}),
		),
	)

/** The edges the particle canvas animates (relation edges carry no traffic), serialized. */
export const particleTracks = (graph: EffectiveGraph, positions: Positions, measured: Measured): string =>
	JSON.stringify(
		drawableEdges(graph, positions, measured).flatMap(({ edge, source, target }) => {
			if (edge.data?.relation !== undefined) return []
			const geometry = edgeGeometry(edge, source, target)
			return [
				{
					id: edge.id,
					path: geometry.path,
					sourceColor: geometry.sourceColor,
					callsPerSecond: geometry.callsPerSecond,
					strokeWidth: geometry.strokeWidth,
				},
			]
		}),
	)

export const miniMapNodes = (
	graph: EffectiveGraph,
	positions: Positions,
	measured: Measured,
	selectedId: Option.Option<string>,
	colorMode: ColorMode,
): ReadonlyArray<MiniMapNode> =>
	graph.nodes.flatMap((node) => {
		const size = measured[node.id]
		if (size === undefined) return []
		const { x, y } = positionOf(positions, node)
		const fill = getServiceMapNodeColor(nodeData(graph, node, selectedId, colorMode), colorMode)
		return [{ x, y, width: size.width, height: size.height, fill }]
	})

/** The minimap's rects, rebuilt only when the nodes or their colours change. */
export const miniMapRectsLayer = <M>(
	h: HtmlBuilder<M>,
	graph: EffectiveGraph,
	positions: Positions,
	measured: Measured,
	selectedId: Option.Option<string>,
	colorMode: ColorMode,
): Html => miniMapRects(h, miniMapNodes(graph, positions, measured, selectedId, colorMode))

/** The particle canvas, re-rendered only when the edge geometry changes. */
export const particleLayer = <M>(
	h: HtmlBuilder<M, AnimateParticlesRequirement>,
	graph: EffectiveGraph,
	positions: Positions,
	measured: Measured,
	toMessage: (message: Message) => M,
): Html =>
	particleCanvas(h, particleTracks(graph, positions, measured), () =>
		toMessage(Message.CompletedMountParticles()),
	)
