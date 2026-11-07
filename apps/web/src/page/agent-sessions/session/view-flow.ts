import { shortTarget } from "../../../lib/agent-sessions/span-filters"
import { formatDuration } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { getSmoothStepPath, Position } from "@xyflow/system"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Canvas from "@maple/views/service-map/xyflow/canvas"
import {
	edgesLayer,
	flowCanvas,
	flowEdge,
	flowHandle,
	flowNode,
	nodesLayer,
} from "@maple/views/service-map/xyflow/view"
import { emptyMessage } from "@maple/views/ui/empty"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { pressable } from "@maple/views/ui/pressable"
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
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

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
	pressable(
		h,
		{
			onClick: Message.ClickedSpan({ spanId: isSelected ? undefined : node.span.spanId }),
			className: cn(
				"flex size-full flex-col justify-center gap-1 rounded-md border bg-card px-2.5 py-2 text-left hover:border-ring active:border-ring",
				"focus-visible:ring-ring",
				node.isErrored ? "border-severity-error-a4" : "border-border",
				isSelected && "border-primary bg-primary-a1",
			),
			attributes: [
				...(isSelected ? [h.AriaCurrent("true")] : []),
				h.AriaHasPopup("dialog"),
				h.DataAttribute("span-id", node.span.spanId),
			],
		},
		[
			hstack(h, { gap: "1.5", as: "span" }, [
				icon(h, node.isErrored ? "CircleXmarkIcon" : CATEGORY_ICON[node.category], {
					size: 12,
					className: cn(
						"shrink-0",
						node.isErrored ? "text-severity-error" : CATEGORY_TEXT[node.category],
					),
				}),
				typography(
					h,
					{ size: "xs", truncate: true, className: "min-w-0", attributes: [h.Title(node.title)] },
					[shortTarget(node.title)],
				),
				...(node.count > 1
					? [
							typography(
								h,
								{ size: "2xs", tone: "muted", numeric: true, className: "shrink-0" },
								["×", String(node.count)],
							),
						]
					: []),
			]),
			h.span(
				[
					h.Class(
						cn(
							typographyClass({ size: "2xs", truncate: true }),
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
					...(lane.turn.failed
						? [typography(h, { size: "xs", tone: "error", as: "p" }, ["failed"])]
						: []),
				],
			),
		],
	})
}

const nodesOf = (h: H, model: Model, lanes: ReadonlyArray<FlowLane>): Html =>
	nodesLayer(
		h,
		Arr.flatMap(lanes, (lane) => [
			laneLabel(h, lane),
			...Arr.map(lane.nodes, (node) =>
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
		Arr.flatMap(lanes, (lane) =>
			Arr.map(lane.edges, ([from, to]) => {
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
	return hstack(
		h,
		{
			gap: "1",
			align: "center",
			className: "pointer-events-auto rounded-md bg-background/80 p-0.5 backdrop-blur-sm",
		},
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
	vstack(h, { className: "sticky bottom-0 z-10 mt-auto" }, [
		hstack(h, { gap: "4", align: "end", justify: "between", className: "pointer-events-none p-3" }, [
			hstack(
				h,
				{
					align: "stretch",
					wrap: true,
					className:
						"pointer-events-auto gap-x-4 gap-y-1 rounded-md bg-background/80 px-2 py-1 text-muted-foreground text-xs backdrop-blur-sm",
				},
				[
					...Arr.map(LEGEND, (category) =>
						hstack(h, { gap: "1.5", as: "span", attributes: [h.Key(category)] }, [
							icon(h, CATEGORY_ICON[category], {
								size: 12,
								className: cn("shrink-0", CATEGORY_TEXT[category]),
							}),
							category,
						]),
					),
					hstack(h, { gap: "1.5", as: "span" }, [
						icon(h, "CircleXmarkIcon", {
							size: 12,
							className: "shrink-0 text-severity-error",
						}),
						"error",
					]),
				],
			),
			controls(h, model),
		]),
	])

export const flow = (h: H, model: Model, data: SessionData): Html => {
	const lanes = layoutLanes(data.turns, {
		mergeRepeats: model.options.mergeRepeats,
		query: model.query,
		agentSpansOnly: model.options.agentSpansOnly,
	})
	const extent = translateExtentOf(lanes)
	return vstack(
		h,
		{ className: "relative grow" },
		lanes.length === 0
			? [emptyMessage(h, {}, ["No spans match this filter"])]
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
