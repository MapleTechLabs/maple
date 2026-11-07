import type { V2Investigation } from "@maple/domain/http/v2"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { ActionKind } from "@maple/web-data/investigations/action-target"
import { splitDuration } from "@maple/web-data/investigations/display"
import {
	ACTION_WIDTH,
	type ActionNodeData,
	type FlowGlyph,
	type PendingVerdictNodeData,
	type ProvenanceEdge,
	type ProvenanceGraph,
	type ProvenanceNode,
	SPINE_WIDTH,
	type SpineNodeData,
} from "@maple/web-data/investigations/provenance-graph"
import { getSmoothStepPath, Position } from "@xyflow/system"
import { Option, Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { DEFAULT_GESTURES } from "@maple/views/service-map/xyflow/attach"
import * as Canvas from "@maple/views/service-map/xyflow/canvas"
import {
	edgesLayer,
	flowCanvas,
	flowEdge,
	flowHandle,
	flowNode,
	nodesLayer,
} from "@maple/views/service-map/xyflow/view"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon, type IconName } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { pressable } from "@maple/views/ui/pressable"
import { skeleton, skeletonMeter } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { relativeTime } from "../../kit/relative-time"
import { NODE_LINK_ATTRIBUTE } from "../clicks"
import { MountNodeLinks } from "./command"
import { CONTROL_GUTTER, fitScale, graphOf, HEADING_GUTTER } from "./graph"
import { Message } from "./message"
import type { Model } from "./model"
import { hstack, hstackClass, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// `ProvenanceCanvas`, `FlowEdge`, the flow nodes and `ProvenanceCanvasLoading`.

type H = HtmlBuilder<Message>

const GLYPH = {
	issue: "CircleWarningIcon",
	check: "RadioCheckedIcon",
	incident: "BellIcon",
	investigation: "MagnifierIcon",
	verdict: "CircleCheckIcon",
} as const satisfies Record<FlowGlyph, IconName>

export const ACTION_GLYPH = {
	rollback: { icon: "RocketIcon", label: "Deploy or rollback" },
	alert: { icon: "BellIcon", label: "Alerting" },
	dashboard: { icon: "ChartBarIcon", label: "Dashboard" },
	traces: { icon: "PulseIcon", label: "Traces" },
	logs: { icon: "FileIcon", label: "Logs" },
	issue: { icon: "CircleWarningIcon", label: "Error issue" },
	config: { icon: "SlidersIcon", label: "Configuration" },
	code: { icon: "CodeIcon", label: "Code change" },
	service: { icon: "ServerIcon", label: "Service setup" },
	task: { icon: "BoltIcon", label: "Action" },
} as const satisfies Record<ActionKind, { icon: IconName; label: string }>

const HANDLE = "!size-0 !min-h-0 !min-w-0 !border-0 !bg-transparent"

const ports = (h: H, id: string): ReadonlyArray<Html> => [
	flowHandle(h, id, "target", "left", HANDLE),
	flowHandle(h, id, "source", "right", HANDLE),
]

/** `LiveBar`: a short amber sweep; `edge` pins it to the card's bottom edge. */
const liveBar = (h: H, isEdge: boolean): Html =>
	h.span(
		[
			h.AriaHidden(true),
			h.Class(
				cn(
					"overflow-hidden bg-primary-a3",
					isEdge
						? "absolute inset-x-0 bottom-0 h-[3px]"
						: "relative block h-[3px] w-full shrink-0 rounded-full",
				),
			),
		],
		[
			h.span([
				h.Class(
					cn(
						"provenance-progress-fill absolute inset-y-0 w-2/5 bg-primary",
						isEdge ? null : "rounded-full",
					),
				),
			]),
		],
	)

type Clock = Readonly<{ nowMs: number; timeZone: string }>

/** Routed by `MountNodeLinks` on the canvas. */
const nodeLink = (h: H) => h.Attribute(NODE_LINK_ATTRIBUTE, "")

/** `FlowSpineNode`. */
const spineNode = (h: H, id: string, data: SpineNodeData, clock: Clock): ReadonlyArray<Html> => {
	const isCurrent = data.current === true
	const body = [
		hstack(h, { gap: "1.5" }, [
			h.span(
				[
					h.Class(
						cn(
							"relative flex size-5.5 shrink-0 items-center justify-center rounded-sm",
							isCurrent ? "bg-primary text-primary-foreground" : "bg-muted",
							data.lifted === true && !isCurrent ? "bg-background" : null,
						),
					),
				],
				[
					icon(h, GLYPH[data.glyph], {
						size: 14,
						className: cn(
							"relative",
							isCurrent ? null : data.glyph === "verdict" ? TONE_TEXT.info : TONE_TEXT.crit,
						),
					}),
				],
			),
			eyebrow(
				h,
				{
					className: cn(
						"min-w-0 flex-1 truncate tracking-wider",
						isCurrent ? "text-primary" : "text-muted-foreground",
					),
				},
				[data.eyebrow],
			),
		]),
		h.p(
			[
				// One unbroken token (an error class, an id) ends in an ellipsis rather than breaking mid-word.
				h.Class(
					cn(
						/\s/.test(data.title) ? "line-clamp-2 break-words" : "truncate",
						"font-mono text-xs leading-[1.35] text-foreground",
						isCurrent ? "text-sm" : null,
					),
				),
				h.Title(data.titleHint ?? data.title),
			],
			[data.title],
		),
		...(data.phase
			? [
					eyebrow(
						h,
						{
							as: "p",
							className: "truncate text-4xs leading-3 text-primary",
							attributes: [h.Title(data.phase)],
						},
						[data.phase],
					),
				]
			: []),
		...(data.live === true ? [liveBar(h, false)] : []),
		...(data.status
			? [
					h.p(
						[h.Class("flex items-baseline gap-1 text-4xs leading-3")],
						[
							h.span(
								[
									h.Class(
										cn(
											"shrink-0 font-medium tracking-wider",
											TONE_TEXT[data.statusTone ?? "crit"],
										),
									),
								],
								[data.status],
							),
							...(data.detail
								? [
										h.span(
											[h.Class("min-w-0 flex-1 truncate text-muted-foreground")],
											[data.detail],
										),
									]
								: []),
						],
					),
				]
			: []),
		...(data.note
			? [
					typography(
						h,
						{
							size: "3xs",
							tone: "muted",
							as: "p",
							className: "whitespace-pre-line leading-[1.4]",
						},
						[data.note, ...(isCurrent ? ["\nyou are here"] : [])],
					),
				]
			: []),
		...(data.at
			? [
					relativeTime(h, {
						value: data.at,
						nowMs: clock.nowMs,
						timeZone: clock.timeZone,
						variant: "orDate",
						mono: true,
						className: "mt-auto pt-0.5 text-4xs leading-3 text-foreground-subtle",
					}),
				]
			: []),
	]
	const shell = cn(
		"flex size-full flex-col gap-1.5 overflow-hidden rounded-md border p-3",
		data.at ? "justify-start" : "justify-center",
		isCurrent
			? "border-primary bg-card"
			: data.lifted === true
				? "border-border bg-muted"
				: "border-border bg-card",
	)
	return [
		...ports(h, id),
		data.href
			? h.a(
					[
						h.Href(data.href),
						h.Class(cn(shell, "hover:border-primary-a4 active:border-primary-a4")),
						h.Title(data.titleHint ?? data.title),
						nodeLink(h),
					],
					body,
				)
			: h.div([h.Class(shell)], body),
	]
}

/** `FlowPendingVerdictNode`: the step after the investigation while no verdict exists. */
const pendingVerdictNode = (h: H, id: string, data: PendingVerdictNodeData): ReadonlyArray<Html> => [
	...ports(h, id),
	vstack(
		h,
		{
			gap: "1.5",
			justify: "center",
			className: "relative size-full overflow-hidden rounded-md border border-dashed bg-background p-3",
		},
		[
			hstack(h, { gap: "1.5", align: "start" }, [
				hstack(
					h,
					{
						align: "center",
						justify: "center",
						as: "span",
						className: "size-5.5 shrink-0 rounded-sm border border-dashed",
					},
					[icon(h, "ClockIcon", { size: 14, className: "text-muted-foreground" })],
				),
				eyebrow(h, { className: "min-w-0 flex-1 leading-[1.3] text-muted-foreground" }, [data.word]),
			]),
			...(data.note
				? [
						typography(h, { size: "3xs", tone: "muted", as: "p", className: "leading-[1.4]" }, [
							data.note,
						]),
					]
				: []),
			vstack(h, { gap: "1", className: "pt-0.5", attributes: [h.AriaHidden(true)] }, [
				skeletonMeter(h),
				skeletonMeter(h, "half"),
			]),
			liveBar(h, true),
		],
	),
]

/** `FlowActionGhostNode`: a proposed action that has not been proposed yet. */
const actionGhostNode = (h: H, id: string): ReadonlyArray<Html> => [
	...ports(h, id),
	hstack(
		h,
		{
			gap: "2.5",
			align: "center",
			className: "pointer-events-none size-full rounded-md border border-dashed bg-surface-faint px-3",
			attributes: [h.AriaHidden(true)],
		},
		[
			vstack(
				h,
				{ gap: "1.5", align: "center", as: "span", className: "w-4 shrink-0 self-start pt-3" },
				[skeleton(h, "h-1.5 w-3 rounded-full"), skeleton(h, "size-3.5 rounded-sm")],
			),
			vstack(h, { gap: "1.5", shrink: true, grow: true, className: "py-2.5" }, [
				skeleton(h, "h-2 w-full rounded-full"),
				skeleton(h, "h-2 w-2/3 rounded-full"),
				skeleton(h, "h-1.5 w-16 rounded-full"),
			]),
		],
	),
]

const openKey = (index: number) => (key: string) =>
	key === "Enter" || key === " " ? Option.some(Message.ClickedAction({ index })) : Option.none()

/** `FlowActionNode`: the whole card opens the action's detail; its link goes where the action is done. */
const actionNode = (h: H, id: string, data: ActionNodeData): ReadonlyArray<Html> => {
	const glyph = ACTION_GLYPH[data.kind]
	return [
		...ports(h, id),
		hstack(
			h,
			{
				gap: "2.5",
				align: "center",
				className:
					"size-full cursor-pointer rounded-md border bg-card px-3 hover:border-primary-a4 active:border-primary-a4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
				attributes: [
					h.Role("button"),
					h.Tabindex(0),
					h.AriaLabel(`Proposed action ${data.ordinal}: ${data.text}`),
					h.OnClick(Message.ClickedAction({ index: data.index })),
					h.OnKeyDownPreventDefault(openKey(data.index)),
				],
			},
			[
				vstack(
					h,
					{ gap: "1.5", align: "center", as: "span", className: "w-4 shrink-0 self-start pt-3" },
					[
						typography(
							h,
							{ size: "3xs", tone: "muted", mono: true, numeric: true, className: "leading-3" },
							[data.ordinal],
						),
						hstack(
							h,
							{
								align: "center",
								justify: "center",
								as: "span",
								className: "size-3.5 text-muted-foreground",
								attributes: [h.Title(glyph.label)],
							},
							[icon(h, glyph.icon, { size: 12, attributes: [h.AriaLabel(glyph.label)] })],
						),
					],
				),
				vstack(h, { gap: "1.5", shrink: true, grow: true, className: "py-2.5" }, [
					typography(
						h,
						{ size: "xs", tone: "foreground", as: "p", className: "line-clamp-2 leading-[1.4]" },
						[data.text],
					),
					h.p(
						[h.Class(hstackClass({ gap: "1.5" }))],
						[
							...(data.target === null
								? []
								: [
										h.a(
											[
												h.Href(data.target.href),
												h.Class(
													"shrink-0 text-4xs font-medium tracking-wider text-primary hover:underline active:underline",
												),
												nodeLink(h),
											],
											[data.target.label, " →"],
										),
									]),
							h.span(
								[
									h.Class(
										"min-w-0 flex-1 truncate text-right text-4xs tracking-wider text-foreground-subtle",
									),
								],
								[data.promise],
							),
						],
					),
				]),
			],
		),
	]
}

export const nodeChildren = (h: H, node: ProvenanceNode, clock: Clock): ReadonlyArray<Html> => {
	switch (node.type) {
		case "spine":
			return spineNode(h, node.id, node.data, clock)
		case "pendingVerdict":
			return pendingVerdictNode(h, node.id, node.data)
		case "actionGhost":
			return actionGhostNode(h, node.id)
		case "action":
			return actionNode(h, node.id, node.data)
		case "heading":
			return [
				eyebrow(
					h,
					{
						className:
							"pointer-events-none block whitespace-nowrap text-4xs leading-3 tracking-widest text-muted-foreground",
					},
					[node.data.text],
				),
			]
	}
}

type Anchors = ReadonlyMap<string, ProvenanceNode>

/** The handle points: zero-size ports centred on each card's left and right edges. */
const sourceOf = (node: ProvenanceNode) => ({
	x: node.position.x + node.width,
	y: node.position.y + node.height / 2,
})
const targetOf = (node: ProvenanceNode) => ({ x: node.position.x, y: node.position.y + node.height / 2 })

const geometryOf = (edge: ProvenanceEdge, anchors: Anchors) => {
	const source = anchors.get(edge.source)
	const target = anchors.get(edge.target)
	if (source === undefined || target === undefined) return null
	const from = sourceOf(source)
	const to = targetOf(target)
	const [path, labelX] = getSmoothStepPath({
		sourceX: from.x,
		sourceY: from.y,
		targetX: to.x,
		targetY: to.y,
		sourcePosition: Position.Right,
		targetPosition: Position.Left,
		borderRadius: 8,
		offset: 16,
	})
	return { from, to, path, labelX }
}

/** `FlowEdge`: dashed strand and its two port dots; a live strand takes the amber. */
export const edgeView = (h: H, edge: ProvenanceEdge, anchors: Anchors): Html | null => {
	const geometry = geometryOf(edge, anchors)
	if (geometry === null) return null
	const isLive = edge.live === true
	const dot = isLive ? "fill-primary" : "fill-muted-foreground"
	return flowEdge(h, {
		id: edge.id,
		type: "provenance",
		source: edge.source,
		target: edge.target,
		children: [
			h.path([
				h.Class(
					cn(
						"react-flow__edge-path",
						isLive
							? edge.kind === "roadmap"
								? "provenance-strand-roadmap"
								: "provenance-strand"
							: null,
					),
				),
				h.Attribute("d", geometry.path),
				h.Attribute("fill", "none"),
				h.Style({
					stroke: isLive ? "var(--primary)" : "var(--muted-foreground)",
					"stroke-opacity": isLive ? "0.7" : "0.45",
					"stroke-width": "1",
					"stroke-dasharray": edge.kind === "roadmap" ? "4, 4" : "3, 3",
				}),
			]),
			h.path([
				h.Class("react-flow__edge-interaction"),
				h.Attribute("d", geometry.path),
				h.Attribute("fill", "none"),
				h.Attribute("stroke-opacity", "0"),
				h.Attribute("stroke-width", "20"),
			]),
			h.circle([
				h.Attribute("cx", String(geometry.from.x)),
				h.Attribute("cy", String(geometry.from.y)),
				h.Attribute("r", "2.5"),
				h.Class(dot),
			]),
			h.circle([
				h.Attribute("cx", String(geometry.to.x)),
				h.Attribute("cy", String(geometry.to.y)),
				h.Attribute("r", "2.5"),
				h.Class(dot),
			]),
		],
	})
}

/** The edge's word, parked above the midpoint of its straight run. */
export const edgeLabel = (h: H, edge: ProvenanceEdge, anchors: Anchors): Html | null => {
	const geometry = edge.label ? geometryOf(edge, anchors) : null
	if (geometry === null || !edge.label) return null
	return eyebrow(
		h,
		{
			variant: "mono",
			className:
				"pointer-events-none absolute z-10 whitespace-pre text-center text-4xs leading-3 text-muted-foreground",
			attributes: [
				h.Style({
					transform: `translate(-50%, -100%) translate(${geometry.labelX}px, ${geometry.from.y - 7}px)`,
				}),
			],
		},
		[Str.replace(" ", "\n")(edge.label)],
	)
}

const CONTROL =
	"flex size-6.5 items-center justify-center text-muted-foreground hover:text-foreground active:text-foreground"

/** The four zoom buttons: the wheel scrolls the page here. */
const controls = (h: H): Html =>
	hstack(
		h,
		{ align: "stretch", className: "absolute bottom-0 left-0 divide-x rounded-sm border bg-background" },
		[
			h.span(
				[h.AriaHidden(true), h.Class(cn(CONTROL, "cursor-default"))],
				[icon(h, "CursorIcon", { size: 12 })],
			),
			pressable(
				h,
				{
					onClick: Message.GotCanvasMessage({ message: Canvas.Message.ClickedZoomIn() }),
					label: "Zoom in",
					className: CONTROL,
				},
				[icon(h, "PlusIcon", { size: 12 })],
			),
			pressable(
				h,
				{
					onClick: Message.GotCanvasMessage({ message: Canvas.Message.ClickedZoomOut() }),
					label: "Zoom out",
					className: CONTROL,
				},
				[icon(h, "MinusIcon", { size: 12 })],
			),
			pressable(
				h,
				{
					onClick: Message.ClickedPlaceGraph(),
					label: "Fit the graph to the view",
					className: CONTROL,
				},
				[icon(h, "MaximizeIcon", { size: 12 })],
			),
		],
	)

const outlineText = (node: ProvenanceNode): string | null => {
	switch (node.type) {
		case "spine":
			return `${node.data.eyebrow}: ${node.data.title}${node.data.status ? `, ${node.data.status}` : ""}${node.data.phase ? `, ${node.data.phase}` : ""}`
		case "pendingVerdict":
			return `${node.data.word}${node.data.note ? `: ${node.data.note}` : ""}`
		case "actionGhost":
			return node.data.slot === 0 ? "Proposed actions pending" : null
		default:
			return null
	}
}

/** `GraphOutline`: the same chain as a list, the keyboard and screen-reader route into the canvas. */
const outline = (h: H, graph: ProvenanceGraph): Html =>
	h.ol(
		[h.Class("sr-only")],
		Arr.map(
			Arr.filter(graph.nodes, (node) => node.type !== "heading"),
			(node) =>
				h.keyed("li")(
					node.id,
					[],
					node.type === "action"
						? [
								pressable(h, { onClick: Message.ClickedAction({ index: node.data.index }) }, [
									`Proposed action ${node.data.ordinal}: ${node.data.text}`,
								]),
							]
						: Option.toArray(Option.fromNullishOr(outlineText(node))),
				),
		),
	)

const PROVENANCE_HINT = "what produced this investigation, and what it produced"

/** `Caption`: a running pass counts up against the page clock. */
const caption = (h: H, graph: ProvenanceGraph, nowMs: number): Html => {
	const running =
		graph.runningSince === null ? null : splitDuration(Math.max(0, nowMs - graph.runningSince))
	return hstack(h, { gap: "2.5" }, [
		eyebrow(h, {}, ["Provenance"]),
		typography(h, { size: "xs", tone: "muted", truncate: true, className: "min-w-0 flex-1" }, [
			PROVENANCE_HINT,
		]),
		...(graph.caption
			? [
					hstack(
						h,
						{
							gap: "1.5",
							align: "center",
							as: "span",
							className: "shrink-0 font-mono text-xs text-muted-foreground tabular-nums",
						},
						[
							...(running === null ? [] : [statusDot(h, { tone: "live" })]),
							graph.caption,
							...(running === null
								? []
								: [
										typography(h, { tone: "foreground" }, [
											` · ${running.value}${running.unit}`,
										]),
									]),
						],
					),
				]
			: []),
	])
}

const PANEL = "shrink-0 gap-3.5 bg-surface-faint px-6 pb-5.5 pt-4.5"

/** `ProvenanceCanvas`; a chain of fewer than two cards draws nothing (or the ghost, mid-run). */
export const provenanceCanvas = (
	h: H,
	model: Model,
	investigation: V2Investigation,
	timeZone: string,
): Html | null => {
	const graph = graphOf(investigation, timeZone)
	if (Arr.filter(graph.nodes, (node) => node.type !== "heading").length < 2)
		return investigation.status === "investigating" ? provenanceLoading(h) : null
	const anchors: Anchors = new Map(Arr.map(graph.nodes, (node) => [node.id, node]))
	const clock = { nowMs: model.nowMs, timeZone }
	const scale = fitScale(model.canvas.pane.width, graph)
	return panel(h, { className: PANEL }, [
		caption(h, graph, model.nowMs),
		h.div(
			[
				h.Class("relative w-full"),
				h.Style({ height: `${graph.height * scale + HEADING_GUTTER + CONTROL_GUTTER}px` }),
				h.OnMount(MountNodeLinks()),
			],
			[
				flowCanvas(h, {
					model: model.canvas,
					toMessage: (message) => Message.GotCanvasMessage({ message }),
					ariaLabel: "Investigation provenance graph",
					gestures: {
						...DEFAULT_GESTURES,
						zoomOnScroll: false,
						zoomOnDoubleClick: false,
						preventScrolling: false,
					},
					edges: edgesLayer(
						h,
						Arr.flatMap(graph.edges, (edge) =>
							Option.toArray(Option.fromNullishOr(edgeView(h, edge, anchors))),
						),
					),
					edgeLabels: Arr.flatMap(graph.edges, (edge) =>
						Option.toArray(Option.fromNullishOr(edgeLabel(h, edge, anchors))),
					),
					nodes: nodesLayer(
						h,
						Arr.map(graph.nodes, (node) =>
							flowNode(h, {
								id: node.id,
								type: node.type,
								position: node.position,
								measured: true,
								style: { width: `${node.width}px`, height: `${node.height}px` },
								children: nodeChildren(h, node, clock),
							}),
						),
					),
					panels: [],
				}),
				controls(h),
				outline(h, graph),
			],
		),
	])
}

// The ghost canvas shown while the provenance graph loads.
const GUTTER = 52
const SPINE_H = 128
const SPINE_H_LIVE = 148
const ACTION_H = 76
const ACTION_GAP = 8
const HEADING_OFFSET = 20
const COLUMN_X = Arr.map([0, 1, 2, 3, 4], (index) => index * (SPINE_WIDTH + GUTTER))
const GRAPH_W = 4 * (SPINE_WIDTH + GUTTER) + ACTION_WIDTH
const GRAPH_H = Math.max(SPINE_H_LIVE, ACTION_H * 2 + ACTION_GAP)

type Card = Readonly<{ x: number; y: number; w: number; h: number }>

const topOf = (height: number) => (GRAPH_H - height) / 2
const spineCard = (column: number, height: number): Card => ({
	x: COLUMN_X[column] ?? 0,
	y: topOf(height),
	w: SPINE_WIDTH,
	h: height,
})
const SPINE_A = spineCard(0, SPINE_H)
const SPINE_B = spineCard(1, SPINE_H)
const SPINE_C = spineCard(2, SPINE_H_LIVE)
const GHOST_SPINE = [SPINE_A, SPINE_B, SPINE_C]
const GHOST_VERDICT = spineCard(3, SPINE_H)
const GHOST_ACTIONS: ReadonlyArray<Card> = Arr.map([0, 1], (index) => ({
	x: COLUMN_X[4] ?? 0,
	y: topOf(ACTION_H * 2 + ACTION_GAP) + index * (ACTION_H + ACTION_GAP),
	w: ACTION_WIDTH,
	h: ACTION_H,
}))
const rightOf = (card: Card) => ({ x: card.x + card.w, y: card.y + card.h / 2 })
const leftOf = (card: Card) => ({ x: card.x, y: card.y + card.h / 2 })

const stepPath = (a: { x: number; y: number }, b: { x: number; y: number }): string => {
	if (Math.abs(a.y - b.y) < 0.5) return `M${a.x},${a.y} H${b.x}`
	const mid = (a.x + b.x) / 2
	const down = b.y > a.y ? 1 : -1
	return Arr.join(
		[
			`M${a.x},${a.y}`,
			`H${mid - 8}`,
			`Q${mid},${a.y} ${mid},${a.y + down * 8}`,
			`V${b.y - down * 8}`,
			`Q${mid},${b.y} ${mid + 8},${b.y}`,
			`H${b.x}`,
		],
		" ",
	)
}

const STRANDS = [
	{ d: stepPath(rightOf(SPINE_A), leftOf(SPINE_B)), dash: "3 3" },
	{ d: stepPath(rightOf(SPINE_B), leftOf(SPINE_C)), dash: "3 3" },
	{ d: stepPath(rightOf(SPINE_C), leftOf(GHOST_VERDICT)), dash: "3 3" },
	...Arr.map(GHOST_ACTIONS, (action) => ({
		d: stepPath(rightOf(GHOST_VERDICT), leftOf(action)),
		dash: "4 4",
	})),
]
const PORTS = [
	rightOf(SPINE_A),
	leftOf(SPINE_B),
	rightOf(SPINE_B),
	leftOf(SPINE_C),
	rightOf(SPINE_C),
	leftOf(GHOST_VERDICT),
	rightOf(GHOST_VERDICT),
	...Arr.map(GHOST_ACTIONS, leftOf),
]

const BAR = "var(--muted-foreground)"

const bar = (
	h: H,
	options: Readonly<{ x: number; y: number; w: number; h?: number; opacity?: number; delay?: number }>,
): Html => {
	const height = options.h ?? 5
	return h.rect([
		h.Attribute("x", String(options.x)),
		h.Attribute("y", String(options.y)),
		h.Attribute("width", String(options.w)),
		h.Attribute("height", String(height)),
		h.Attribute("rx", String(height / 2)),
		h.Attribute("fill", BAR),
		h.Attribute("opacity", String(options.opacity ?? 0.2)),
		...(options.delay === undefined
			? []
			: [h.Class("provenance-load-bar"), h.Style({ "animation-delay": `${options.delay}s` })]),
	])
}

const cardRect = (h: H, card: Card): Html =>
	h.rect([
		h.Attribute("x", String(card.x)),
		h.Attribute("y", String(card.y)),
		h.Attribute("width", String(card.w)),
		h.Attribute("height", String(card.h)),
		h.Attribute("rx", "8"),
		h.Attribute("fill", "var(--card)"),
		h.Attribute("stroke", "var(--border)"),
		h.Attribute("stroke-width", "1"),
	])

const spineGhost = (h: H, card: Card, delay: number): Html =>
	h.g(
		[h.Class("provenance-load-node"), h.Style({ "animation-delay": `${delay}s` })],
		[
			cardRect(h, card),
			h.rect([
				h.Attribute("x", String(card.x + 12)),
				h.Attribute("y", String(card.y + 10)),
				h.Attribute("width", "22"),
				h.Attribute("height", "22"),
				h.Attribute("rx", "4"),
				h.Attribute("fill", "var(--muted)"),
			]),
			bar(h, { x: card.x + 40, y: card.y + 18, w: 62, opacity: 0.28 }),
			bar(h, { x: card.x + 12, y: card.y + 44, w: card.w - 24, h: 6, delay }),
			bar(h, { x: card.x + 12, y: card.y + 58, w: (card.w - 24) * 0.62, h: 6, opacity: 0.16 }),
			bar(h, { x: card.x + 12, y: card.y + card.h - 18, w: 44, opacity: 0.14 }),
		],
	)

const actionGhost = (h: H, card: Card, delay: number): Html =>
	h.g(
		[h.Class("provenance-load-node"), h.Style({ "animation-delay": `${delay}s` })],
		[
			cardRect(h, card),
			bar(h, { x: card.x + 12, y: card.y + 14, w: 12, opacity: 0.24 }),
			h.rect([
				h.Attribute("x", String(card.x + 11)),
				h.Attribute("y", String(card.y + 26)),
				h.Attribute("width", "14"),
				h.Attribute("height", "14"),
				h.Attribute("rx", "3"),
				h.Attribute("fill", BAR),
				h.Attribute("opacity", "0.16"),
			]),
			bar(h, { x: card.x + 34, y: card.y + 18, w: card.w - 60, h: 6, delay }),
			bar(h, { x: card.x + 34, y: card.y + 32, w: (card.w - 60) * 0.66, h: 6, opacity: 0.16 }),
			bar(h, { x: card.x + 34, y: card.y + card.h - 20, w: 56, opacity: 0.14 }),
		],
	)

/** `ProvenanceCanvasLoading`: the chain it is about to be replaced by, drawn as a ghost. */
export const provenanceLoading = (h: H): Html =>
	panel(h, { className: PANEL, attributes: [h.AriaBusy(true)] }, [
		hstack(h, { gap: "2.5" }, [
			eyebrow(h, {}, ["Provenance"]),
			typography(h, { size: "xs", tone: "muted", truncate: true, className: "min-w-0 flex-1" }, [
				PROVENANCE_HINT,
			]),
			eyebrow(h, { variant: "mono", className: hstackClass({ gap: "1.5", className: "shrink-0" }) }, [
				h.span([], ["Mapping the chain"]),
				hstack(
					h,
					{ align: "stretch", inline: true, as: "span", attributes: [h.AriaHidden(true)] },
					Arr.map([0, 1, 2], (index) =>
						h.span([h.Key(String(index)), h.Class("pulse-dot")], ["."]),
					),
				),
			]),
		]),
		h.svg(
			[
				h.Attribute(
					"viewBox",
					`0 ${-HEADING_OFFSET - 12} ${GRAPH_W} ${GRAPH_H + HEADING_OFFSET + 24}`,
				),
				h.Class("h-auto w-full"),
				h.Role("img"),
				h.AriaLabel("Loading the provenance graph"),
				h.Attribute("fill", "none"),
			],
			[
				bar(h, { x: COLUMN_X[4] ?? 0, y: -HEADING_OFFSET - 5, w: 128, opacity: 0.16 }),
				...Arr.map(STRANDS, (strand, index) =>
					h.path([
						h.Class("provenance-load-strand"),
						h.Style({ "animation-delay": `${0.12 + index * 0.05}s` }),
						h.Attribute("d", strand.d),
						h.Attribute("stroke", "var(--muted-foreground)"),
						h.Attribute("stroke-opacity", "0.45"),
						h.Attribute("stroke-width", "1"),
						h.Attribute("stroke-dasharray", strand.dash),
					]),
				),
				...Arr.map(PORTS, (port, index) =>
					h.circle([
						h.Class("provenance-load-strand"),
						h.Style({ "animation-delay": `${0.12 + index * 0.03}s` }),
						h.Attribute("cx", String(port.x)),
						h.Attribute("cy", String(port.y)),
						h.Attribute("r", "2.5"),
						h.Attribute("fill", BAR),
						h.Attribute("opacity", "0.5"),
					]),
				),
				...Arr.map(GHOST_SPINE, (card, index) => spineGhost(h, card, index * 0.08)),
				spineGhost(h, GHOST_VERDICT, 0.3),
				...Arr.map(GHOST_ACTIONS, (card, index) => actionGhost(h, card, 0.4 + index * 0.07)),
			],
		),
	])
