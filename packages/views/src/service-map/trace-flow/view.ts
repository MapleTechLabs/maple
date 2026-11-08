import { getServiceColor } from "@maple/ui/lib/colors"
import { Option, Array as Arr } from "effect"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { flowIcon } from "./flow-icon"
import type * as Canvas from "../xyflow/canvas"
import {
	type HandleBounds,
	handlePoint,
	type MeasuredNode,
	type PlacedNode,
	type Viewport,
} from "../xyflow/geometry"
import { controls, dotBackground, miniMap } from "../xyflow/panels"
import { edgesLayer, flowCanvas, flowEdge, flowNode, nodesLayer } from "../xyflow/view"
import { isRectVisible } from "../xyflow/viewport"
import { traceFlowEdge } from "./edge"
import { flowLegend } from "./legend"
import { flowSpanNode } from "./node-card"
import { type FlowGraph, isNodeSelected, MAX_FLOW_NODES, Message, type Model } from "./trace-flow"
import { typography } from "../../ui/typography"
import { hstack, vstack } from "../../ui/stack"

/** The node's handle of `type`: a plain scan, since this runs per edge on every render. */
const handleOf = (
	measured: MeasuredNode | undefined,
	type: HandleBounds["type"],
): HandleBounds | undefined => {
	if (measured === undefined) return undefined
	for (const handle of measured.handles) if (handle.type === type) return handle
	return undefined
}

type Pane = Canvas.Model["pane"]

const visible = (node: PlacedNode, viewport: Viewport, pane: Pane): boolean =>
	node.measured === undefined ||
	isRectVisible(
		{ ...node.position, width: node.measured.width, height: node.measured.height },
		viewport,
		pane,
	)

const edgeVisible = (source: PlacedNode, target: PlacedNode, viewport: Viewport, pane: Pane): boolean => {
	if (source.measured === undefined || target.measured === undefined) return false
	const x = Math.min(source.position.x, target.position.x)
	const y = Math.min(source.position.y, target.position.y)
	const x2 = Math.max(source.position.x + source.measured.width, target.position.x + target.measured.width)
	const y2 = Math.max(
		source.position.y + source.measured.height,
		target.position.y + target.measured.height,
	)
	return isRectVisible(
		{ x, y, width: x2 === x ? 1 : x2 - x, height: y2 === y ? 1 : y2 - y },
		viewport,
		pane,
	)
}

/** `onlyRenderVisibleElements`: nodes overlapping the pane, plus any still unmeasured. */
const renderNodes = <M>(
	h: HtmlBuilder<M>,
	graph: FlowGraph,
	model: Model,
	toMessage: (message: Message) => M,
): Html => {
	const placed = new Map(
		Arr.map(graph.nodes, (node) => [node.id, { ...node, measured: model.canvas.measured[node.id] }]),
	)
	return nodesLayer(
		h,
		Arr.flatMap(graph.nodes, (node) => {
			const at = placed.get(node.id)
			if (at === undefined || !visible(at, model.canvas.viewport, model.canvas.pane)) return []
			return [
				flowNode(h, {
					id: node.id,
					type: "span",
					position: node.position,
					measured: at.measured !== undefined,
					onClick: toMessage(Message.ClickedSpanNode({ nodeId: node.id })),
					children: flowSpanNode(h, node.id, node.data, isNodeSelected(node, model.selectedSpanId)),
				}),
			]
		}),
	)
}

const renderEdges = <M>(
	h: HtmlBuilder<M>,
	graph: FlowGraph,
	model: Model,
	toMessage: (message: Message) => M,
): Html => {
	const placed = new Map(
		Arr.map(graph.nodes, (node) => [node.id, { ...node, measured: model.canvas.measured[node.id] }]),
	)
	return edgesLayer(
		h,
		Arr.flatMap(graph.edges, (edge) => {
			const source = placed.get(edge.source)
			const target = placed.get(edge.target)
			if (source === undefined || target === undefined) return []
			if (!edgeVisible(source, target, model.canvas.viewport, model.canvas.pane)) return []
			const sourceHandle = handleOf(source.measured, "source")
			const targetHandle = handleOf(target.measured, "target")
			if (sourceHandle === undefined || targetHandle === undefined) return []
			return [
				flowEdge(h, {
					id: edge.id,
					type: "flowEdge",
					source: edge.source,
					target: edge.target,
					className: "animated",
					children: traceFlowEdge(
						h,
						handlePoint(source, sourceHandle),
						handlePoint(target, targetHandle),
						edge.data,
						Option.contains(model.hoveredEdgeId, edge.id),
						{
							onEnter: toMessage(Message.HoveredEdge({ edgeId: edge.id })),
							onLeave: toMessage(Message.LeftEdge({ edgeId: edge.id })),
						},
					),
				}),
			]
		}),
	)
}

const nodesSlot = createLazy()
const edgesSlot = createLazy()

const minimapColor = (graph: FlowGraph) => {
	const byId = new Map(Arr.map(graph.nodes, (node) => [node.id, node.data.span]))
	return (id: string): string => {
		const span = byId.get(id)
		if (span === undefined) return ""
		return span.statusCode === "Error" ? "var(--severity-error)" : getServiceColor(span.serviceName)
	}
}

const header = <M>(h: HtmlBuilder<M>, onFit: M): Html =>
	hstack(
		h,
		{ align: "center", justify: "between", className: "border-b bg-surface-sunken px-3 py-2 shrink-0" },
		[
			typography(h, { size: "xs", tone: "muted", weight: "medium" }, ["Flow View"]),
			button(
				h,
				{
					variant: "ghost",
					size: "xs",
					attributes: [h.OnClick(onFit)],
				},
				[flowIcon(h, "EyeIcon"), "Fit view"],
			),
		],
	)

/** `TraceFlowView` for a trace that fits the flow view. */
export const view = <M>(
	h: HtmlBuilder<M>,
	graph: FlowGraph,
	model: Model,
	toMessage: (message: Message) => M,
): Html => {
	if (graph.nodeCount > MAX_FLOW_NODES) {
		return h.div(
			[h.Class("border p-8 text-center")],
			[
				typography(h, { tone: "muted", as: "p" }, ["Trace too large for the flow view"]),
				typography(h, { size: "xs", tone: "muted", as: "p", className: "mt-1" }, [
					`${graph.nodeCount.toLocaleString("en-US")} nodes, the limit is ${MAX_FLOW_NODES.toLocaleString("en-US")}. Use the timeline instead.`,
				]),
			],
		)
	}
	const toCanvas = (message: Canvas.Message) => toMessage(Message.GotCanvasMessage({ message }))
	const placed = Arr.map(graph.nodes, (node) => ({ ...node, measured: model.canvas.measured[node.id] }))
	return vstack(h, { className: "h-full overflow-hidden" }, [
		header(h, toMessage(Message.ClickedFitView())),
		h.div(
			[h.Class("flex-1 min-h-0")],
			[
				flowCanvas(h, {
					model: model.canvas,
					toMessage: toCanvas,
					edges: edgesSlot(renderEdges, [h, graph, model, toMessage]) ?? edgesLayer(h, []),
					nodes: nodesSlot(renderNodes, [h, graph, model, toMessage]) ?? nodesLayer(h, []),
					panels: [
						controls(h, model.canvas, toCanvas),
						miniMap(h, model.canvas, placed, {
							className: "!bg-surface-sunken !border-border",
							maskColor: "oklch(0.15 0 0 / 0.8)",
							nodeColor: minimapColor(graph),
						}),
						dotBackground(h, model.canvas, 16, 1),
					],
				}),
			],
		),
		flowLegend(h, graph.input.services, graph.categories),
	])
}
