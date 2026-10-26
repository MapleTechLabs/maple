import type { SpanNode } from "@maple/ui/lib/types"
import { Option, Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import * as Canvas from "../xyflow/canvas"
import {
	findSpanById,
	type FlowEdge,
	type FlowNode,
	getLayoutedElements,
	transformSpansToFlow,
} from "./flow-graph"
import { describeSpan, SPAN_CATEGORIES, type SpanCategory } from "./span-category"

/** `TraceFlowView` (packages/ui `traces/flow-view.tsx`) as a Submodel over a fixed trace. */

/** Past this many nodes the layout and render cost outweighs what the graph can still show. */
export const MAX_FLOW_NODES = 1500

export interface TraceInput {
	readonly rootSpans: ReadonlyArray<SpanNode>
	readonly totalDurationMs: number
	readonly services: ReadonlyArray<string>
}

export interface FlowGraph {
	readonly input: TraceInput
	readonly nodes: ReadonlyArray<FlowNode>
	readonly edges: ReadonlyArray<FlowEdge>
	readonly nodeCount: number
	/** Legend categories that occur in this trace. */
	readonly categories: ReadonlyArray<SpanCategory>
}

export const buildFlowGraph = (input: TraceInput): FlowGraph => {
	const { nodes, edges } = transformSpansToFlow(
		[...input.rootSpans],
		[...input.services],
		input.totalDurationMs,
	)
	if (nodes.length > MAX_FLOW_NODES)
		return { input, nodes: [], edges: [], nodeCount: nodes.length, categories: [] }
	const layouted = getLayoutedElements(nodes, edges)
	const present = new Set(
		layouted.nodes
			.filter((node) => !node.data.span.isMissing)
			.map((node) => describeSpan(node.data.span).category.id),
	)
	return {
		input,
		nodes: layouted.nodes,
		edges: layouted.edges,
		nodeCount: nodes.length,
		categories: SPAN_CATEGORIES.filter((category) => present.has(category.id)),
	}
}

/** `fitView({ padding: 0.2, maxZoom: 1.5 })`, held at a legible zoom; a larger flow pans. */
export const FLOW_FIT: Canvas.FitRequest = {
	padding: 0.2,
	minZoom: 0.1,
	maxZoom: 1.5,
	readableZoom: Canvas.READABLE_FIT_ZOOM,
}

export const Model = Schema.Struct({
	canvas: Canvas.Model,
	selectedSpanId: Schema.Option(Schema.String),
	hoveredEdgeId: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const init = (): Model => ({
	canvas: Canvas.init({ minZoom: 0.1, maxZoom: 2, fitOnInit: Option.some(FLOW_FIT) }),
	selectedSpanId: Option.none(),
	hoveredEdgeId: Option.none(),
})

export const Message = defineMessageUnion({
	GotCanvasMessage: { message: Canvas.Message },
	ClickedSpanNode: { nodeId: Schema.String },
	HoveredEdge: { edgeId: Schema.String },
	LeftEdge: { edgeId: Schema.String },
	ClickedFitView: {},
})
export type Message = typeof Message.Type

/** The node card is selected when it is, or folds in, the selected span. */
export const isNodeSelected = (node: FlowNode, selectedSpanId: Option.Option<string>): boolean =>
	Option.match(selectedSpanId, {
		onNone: () => false,
		onSome: (spanId) =>
			node.id === spanId || node.data.combinedSpans.some((span) => span.spanId === spanId),
	})

/** The Fit view control frames every node, with no legibility floor. */
const FIT_ALL: Canvas.FitRequest = { padding: 0.2, minZoom: 0.1, maxZoom: 1.5 }

const refit = (model: Model, graph: FlowGraph, request: Canvas.FitRequest = FLOW_FIT): Model =>
	modifyFields(model, {
		canvas: () =>
			Canvas.requestFit(
				modifyFields(model.canvas, { movedByUser: () => false }),
				Canvas.placed(model.canvas, graph.nodes),
				request,
			),
	})

export const update =
	(graph: FlowGraph) =>
	(model: Model, message: Message): Model =>
		Message.match(message, {
			GotCanvasMessage: ({ message: canvasMessage }) => {
				const next = modifyFields(model, {
					canvas: () => Canvas.update(model.canvas, canvasMessage, graph.nodes),
				})
				// The pane settles after mount; refit on resize until the user takes over the camera.
				const refitted =
					canvasMessage._tag === "ResizedPane" && !next.canvas.movedByUser
						? refit(next, graph)
						: next
				// After the first fit, the nodes re-measure so handles are measured at the fitted zoom.
				return refitted.canvas.fitsApplied > model.canvas.fitsApplied && !refitted.canvas.movedByUser
					? modifyFields(refitted, { canvas: Canvas.remeasure })
					: refitted
			},
			ClickedSpanNode: ({ nodeId }) => {
				const span = findSpanById([...graph.input.rootSpans], nodeId)
				return span === undefined
					? model
					: modifyFields(model, { selectedSpanId: () => Option.some(span.spanId) })
			},
			HoveredEdge: ({ edgeId }) => modifyFields(model, { hoveredEdgeId: () => Option.some(edgeId) }),
			LeftEdge: ({ edgeId }) =>
				Option.contains(model.hoveredEdgeId, edgeId)
					? modifyFields(model, { hoveredEdgeId: () => Option.none() })
					: model,
			ClickedFitView: () => refit(model, graph, FIT_ALL),
		})
