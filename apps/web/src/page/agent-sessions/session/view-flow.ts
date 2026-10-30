import { shortTarget } from "../../../lib/agent-sessions/span-filters"
import { formatDuration } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { getSmoothStepPath, Position } from "@xyflow/system"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Canvas from "../../../service-map/xyflow/canvas"
import {
	edgesLayer,
	flowCanvas,
	flowEdge,
	flowHandle,
	flowNode,
	nodesLayer,
} from "../../../service-map/xyflow/view"
import { emptyMessage } from "../../../ui/empty"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import type { SessionData } from "./derive"
import {
	CANVAS_PADDING,
	type FlowLane,
	type FlowNode,
	layoutLanes,
	MAX_ZOOM,
	MIN_ZOOM,
	NODE_HEIGHT,
	NODE_WIDTH,
	translateExtentOf,
} from "./flow-layout"
import { Message } from "./message"
import type { Model } from "./model"
import { CATEGORY_ICON, CATEGORY_TEXT } from "./span-visuals"

// The session flow: one lane per turn on the xyflow canvas.
// TODO(list-navigation): the arrow-key node cursor is not ported.

type H = HtmlBuilder<Message>

const HANDLE = "!size-0 !min-h-0 !min-w-0 !border-0 !bg-transparent"
const EDGE_STYLE = {
	stroke: "var(--muted-foreground)",
	"stroke-width": "2",
	"stroke-linecap": "round",
	"stroke-dasharray": "0.5, 5",
}

const toCanvas = (message: Canvas.Message) => Message.GotFlowCanvasMessage({ message })

const stepNode = (h: H, node: FlowNode, isSelected: boolean): ReadonlyArray<Html> => [
	flowHandle(h, node.key, "target", "left", HANDLE),
	flowHandle(h, node.key, "source", "right", HANDLE),
	h.button(
		[
			...(isSelected ? [h.AriaCurrent("true")] : []),
			h.AriaHasPopup("dialog"),
			h.Class(
				cn(
					"flex size-full cursor-pointer flex-col justify-center gap-1 rounded-md border bg-card px-2.5 py-2 text-left hover:border-ring",
					"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					node.isErrored ? "border-severity-error/60" : "border-border",
					isSelected && "border-primary bg-primary/5",
				),
			),
			h.DataAttribute("span-id", node.span.spanId),
			h.Type("button"),
			h.OnClick(Message.ClickedSpan({ spanId: isSelected ? undefined : node.span.spanId })),
		],
		[
			h.span(
				[h.Class("flex items-center gap-1.5")],
				[
					icon(h, node.isErrored ? "CircleXmarkIcon" : CATEGORY_ICON[node.category], {
						size: 12,
						className: cn(
							"shrink-0",
							node.isErrored ? "text-severity-error" : CATEGORY_TEXT[node.category],
						),
					}),
					h.span(
						[h.Class("min-w-0 truncate text-xs"), h.Title(node.title)],
						[shortTarget(node.title)],
					),
					...(node.count > 1
						? [
								h.span(
									[h.Class("shrink-0 text-2xs text-muted-foreground tabular-nums")],
									["×", String(node.count)],
								),
							]
						: []),
				],
			),
			h.span(
				[
					h.Class(
						cn(
							"truncate text-2xs",
							node.isErrored ? "text-severity-error" : "text-muted-foreground",
						),
					),
				],
				[node.subtitle],
			),
		],
	),
]

const laneLabel = (h: H, lane: FlowLane): Html => {
	const top = lane.nodes[0]?.y ?? CANVAS_PADDING
	return flowNode(h, {
		id: `lane:${lane.turn.id}`,
		type: "laneLabel",
		position: { x: CANVAS_PADDING, y: top + 4 },
		measured: true,
		focusable: false,
		style: { "pointer-events": "none" },
		children: [
			h.div(
				[h.Class("pointer-events-none w-28 text-xs")],
				[
					eyebrow(h, { as: "p", className: "text-primary" }, ["Turn ", String(lane.turn.index)]),
					h.p(
						[
							h.Class(
								cn(
									"tabular-nums",
									lane.turn.failed ? "text-severity-error" : "text-muted-foreground",
								),
							),
						],
						[formatDuration(lane.turn.durationMs)],
					),
					...(lane.turn.failed ? [h.p([h.Class("text-severity-error text-xs")], ["failed"])] : []),
				],
			),
		],
	})
}

const nodesOf = (h: H, model: Model, lanes: ReadonlyArray<FlowLane>): Html =>
	nodesLayer(
		h,
		lanes.flatMap((lane) => [
			laneLabel(h, lane),
			...lane.nodes.map((node) =>
				flowNode(h, {
					id: node.key,
					type: "step",
					position: { x: node.x, y: node.y },
					measured: true,
					focusable: false,
					style: { width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` },
					children: stepNode(h, node, model.search.span === node.span.spanId),
				}),
			),
		]),
	)

const edgesOf = (h: H, lanes: ReadonlyArray<FlowLane>, isRelaid: boolean): Html =>
	edgesLayer(
		h,
		lanes.flatMap((lane) =>
			lane.edges.map(([from, to]) => {
				const [path] = getSmoothStepPath({
					sourceX: from.x + NODE_WIDTH + (isRelaid ? 1 : 0),
					sourceY: from.y + NODE_HEIGHT / 2 + (isRelaid ? 0.5 : 0),
					sourcePosition: Position.Right,
					targetX: to.x,
					targetY: to.y + NODE_HEIGHT / 2 + (isRelaid ? 0.5 : 0),
					targetPosition: Position.Left,
					borderRadius: 0,
				})
				return flowEdge(h, {
					id: `${from.key}->${to.key}`,
					type: "step",
					source: from.key,
					target: to.key,
					focusable: false,
					children: [
						h.path([
							h.Class("react-flow__edge-path"),
							h.Attribute("d", path),
							h.Attribute("fill", "none"),
							h.Style(EDGE_STYLE),
						]),
						h.path([
							h.Class("react-flow__edge-interaction"),
							h.Attribute("d", path),
							h.Attribute("fill", "none"),
							h.Attribute("stroke-opacity", "0"),
							h.Attribute("stroke-width", "20"),
						]),
					],
				})
			}),
		),
	)

const LEGEND = ["agent", "inference", "tool"] as const

/** `FlowControls`: in, out, and back to the top of the session at 1:1. */
const controls = (h: H, model: Model): Html => {
	const { zoom } = model.flowCanvas.viewport
	return h.div(
		[
			h.Class(
				"pointer-events-auto flex items-center gap-1 rounded-md bg-background/80 p-0.5 backdrop-blur-sm",
			),
		],
		[
			iconButton(
				h,
				{
					label: "Zoom in",
					isDisabled: zoom >= MAX_ZOOM,
					attributes: [h.OnClick(toCanvas(Canvas.Message.ClickedZoomIn()))],
				},
				[icon(h, "PlusIcon")],
			),
			iconButton(
				h,
				{
					label: "Zoom out",
					isDisabled: zoom <= MIN_ZOOM,
					attributes: [h.OnClick(toCanvas(Canvas.Message.ClickedZoomOut()))],
				},
				[icon(h, "MinusIcon")],
			),
			iconButton(h, { label: "Reset view", attributes: [h.OnClick(Message.ClickedResetFlowView())] }, [
				icon(h, "MaximizeIcon"),
			]),
		],
	)
}

const floor = (h: H, model: Model): Html =>
	h.div(
		[h.Class("sticky bottom-0 z-10 mt-auto flex flex-col")],
		[
			h.div(
				[h.Class("pointer-events-none flex items-end justify-between gap-4 p-3")],
				[
					h.div(
						[
							h.Class(
								"pointer-events-auto flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-background/80 px-2 py-1 text-muted-foreground text-xs backdrop-blur-sm",
							),
						],
						[
							...LEGEND.map((category) =>
								h.span(
									[h.Key(category), h.Class("flex items-center gap-1.5")],
									[
										icon(h, CATEGORY_ICON[category], {
											size: 12,
											className: cn("shrink-0", CATEGORY_TEXT[category]),
										}),
										category,
									],
								),
							),
							h.span(
								[h.Class("flex items-center gap-1.5")],
								[
									icon(h, "CircleXmarkIcon", {
										size: 12,
										className: "shrink-0 text-severity-error",
									}),
									"error",
								],
							),
						],
					),
					controls(h, model),
				],
			),
		],
	)

export const flow = (h: H, model: Model, data: SessionData): Html => {
	const lanes = layoutLanes(data.turns, {
		mergeRepeats: model.options.mergeRepeats,
		query: model.query,
		agentSpansOnly: model.options.agentSpansOnly,
	})
	const extent = translateExtentOf(lanes)
	return h.div(
		[h.Class("relative flex grow flex-col")],
		lanes.length === 0
			? [emptyMessage(h, {}, ["No spans match this filter."])]
			: [
					h.div(
						[h.Class("relative min-h-48 grow")],
						[
							flowCanvas(h, {
								model: model.flowCanvas,
								toMessage: toCanvas,
								edges: edgesOf(h, lanes, model.isFlowRelaid),
								nodes: nodesOf(h, model, lanes),
								panels: [],
								ariaLabel: "Session flow graph",
								gestures: {
									panOnScroll: true,
									zoomOnScroll: false,
									zoomOnDoubleClick: false,
									preventScrolling: true,
									translateExtent: [
										[extent[0][0], extent[0][1]],
										[extent[1][0], extent[1][1]],
									],
								},
							}),
						],
					),
					floor(h, model),
				],
	)
}
