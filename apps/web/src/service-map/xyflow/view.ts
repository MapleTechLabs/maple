import "./react-flow.css"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import {
	ANIMATION_ATTRIBUTE,
	AttachFlowCanvas,
	animationAttribute,
	DEFAULT_GESTURES,
	type FlowGestures,
	LIMITS_ATTRIBUTE,
	limitsAttribute,
	MEASURE_EPOCH_ATTRIBUTE,
	VIEWPORT_ATTRIBUTE,
	viewportAttribute,
} from "./attach"
import type { Message, Model } from "./canvas"
import type { XY } from "./geometry"
import { viewportTransform } from "./viewport"

// React Flow's DOM (`@xyflow/react` 12: ReactFlow, ZoomPane, Pane, Viewport, NodeRenderer,
// EdgeRenderer, A11yDescriptions), class for class and style for style.

const FILL = { position: "absolute", width: "100%", height: "100%", top: "0px", left: "0px" } as const

const NODE_DESCRIPTION =
	"Press enter or space to select a node. You can then use the arrow keys to move the node around. Press delete to remove it and escape to cancel."
const EDGE_DESCRIPTION =
	"Press enter or space to select an edge. You can then press delete to remove it or escape to cancel."

export interface FlowNodeView<M> {
	readonly id: string
	readonly type: string
	readonly position: XY
	readonly measured: boolean
	/** `nopan draggable` for draggable nodes. */
	readonly className?: string
	readonly zIndex?: number
	/** Spread over the wrapper style last, like `node.style`. */
	readonly style?: Readonly<Record<string, string>>
	/** `focusable: false` drops `tabindex` and the `group` role. */
	readonly focusable?: boolean
	readonly onClick?: M
	readonly children: ReadonlyArray<Html>
}

/** `NodeWrapper`: positioned, hidden until measured, focusable `group`. */
export const flowNode = <M>(h: HtmlBuilder<M>, node: FlowNodeView<M>): Html =>
	h.keyed("div")(
		node.id,
		[
			h.Class(
				`react-flow__node react-flow__node-${node.type}${node.className ? ` ${node.className}` : ""}`,
			),
			h.Style({
				"z-index": String(node.zIndex ?? 0),
				transform: `translate(${node.position.x}px,${node.position.y}px)`,
				"pointer-events": "all",
				visibility: node.measured ? "visible" : "hidden",
				...node.style,
			}),
			h.DataAttribute("id", node.id),
			h.DataAttribute("testid", `rf__node-${node.id}`),
			...(node.focusable === false ? [] : [h.Tabindex(0), h.Role("group")]),
			h.Attribute("aria-roledescription", "node"),
			h.AriaDescribedBy("react-flow__node-desc-1"),
			...(node.onClick === undefined ? [] : [h.OnClick(node.onClick, { propagation: "Stop" })]),
		],
		node.children,
	)

/** `<Handle isConnectable={false}>`; `className` is the node's own handle classes. */
export const flowHandle = <M>(
	h: HtmlBuilder<M>,
	nodeId: string,
	type: "source" | "target",
	side: "top" | "right" | "bottom" | "left",
	className: string,
): Html =>
	h.div([
		h.Class(
			`react-flow__handle react-flow__handle-${side} nodrag nopan ${className} ${type} connectablestart connectableend`,
		),
		h.DataAttribute("handlepos", side),
		h.DataAttribute("id", `1-${nodeId}-null-${type}`),
		h.DataAttribute("nodeid", nodeId),
	])

export interface FlowEdgeView {
	readonly id: string
	readonly type: string
	readonly source: string
	readonly target: string
	/** Extra classes, e.g. `animated`. */
	readonly className?: string
	/** `focusable: false` drops `tabindex`; the edge is then an `img`. */
	readonly focusable?: boolean
	readonly children: ReadonlyArray<Html>
}

export interface FlowCanvasView<M> {
	readonly model: Model
	readonly toMessage: (message: Message) => M
	/** `react-flow__edges` content: {@link flowEdge}s, memoized by the caller. */
	readonly edges: Html
	/** `react-flow__nodes` content: {@link flowNode}s, memoized by the caller. */
	readonly nodes: Html
	/** Children rendered after the renderer: controls, minimap, background, overlays. */
	readonly panels: ReadonlyArray<Html>
	readonly onPaneClick?: M
	/** `<ReactFlow aria-label>`. */
	readonly ariaLabel?: string
	/** `panOnScroll`, `zoomOnScroll`, `zoomOnDoubleClick`, `translateExtent`. */
	readonly gestures?: FlowGestures
	/** `EdgeLabelRenderer` portals: absolutely placed labels in flow space. */
	readonly edgeLabels?: ReadonlyArray<Html>
}

const limitsOf = <M>(canvas: FlowCanvasView<M>) => ({
	minZoom: canvas.model.minZoom,
	maxZoom: canvas.model.maxZoom,
	gestures: canvas.gestures ?? DEFAULT_GESTURES,
})

/** `<ReactFlow>`: wrapper, zoom pane, pane, viewport and the a11y descriptions. */
export const flowCanvas = <M>(h: HtmlBuilder<M>, canvas: FlowCanvasView<M>): Html =>
	h.div(
		[
			...(canvas.ariaLabel === undefined ? [] : [h.AriaLabel(canvas.ariaLabel)]),
			h.Class("react-flow light"),
			h.DataAttribute("testid", "rf__wrapper"),
			h.Role("application"),
			h.Style({
				width: "100%",
				height: "100%",
				overflow: "hidden",
				position: "relative",
				"z-index": "0",
			}),
		],
		[
			h.div(
				[
					h.Class("react-flow__renderer"),
					h.Style(FILL),
					h.Attribute(MEASURE_EPOCH_ATTRIBUTE, String(canvas.model.measureEpoch)),
					h.Attribute(LIMITS_ATTRIBUTE, limitsAttribute(limitsOf(canvas))),
					h.OnMount(
						Mount.mapMessage(
							AttachFlowCanvas(limitsOf(canvas)),
							canvas.toMessage,
						),
					),
				],
				[
					h.div(
						[
							h.Class("react-flow__pane draggable"),
							h.Style(FILL),
							...(canvas.onPaneClick === undefined ? [] : [h.OnClick(canvas.onPaneClick)]),
						],
						[
							h.div(
								[
									h.Class("react-flow__viewport xyflow__viewport react-flow__container"),
									h.Style({ transform: viewportTransform(canvas.model.viewport) }),
								],
								[
									canvas.edges,
									h.div([h.Class("react-flow__edgelabel-renderer")], canvas.edgeLabels ?? []),
									canvas.nodes,
									h.div([
										h.Class("react-flow__viewport-portal"),
										h.Attribute(
											VIEWPORT_ATTRIBUTE,
											viewportAttribute(canvas.model.viewport),
										),
										...Option.toArray(
											Option.map(canvas.model.animation, (animation) =>
												h.Attribute(
													ANIMATION_ATTRIBUTE,
													animationAttribute(animation),
												),
											),
										),
									]),
								],
							),
						],
					),
				],
			),
			...canvas.panels,
			h.div([h.Id("react-flow__node-desc-1"), h.Style({ display: "none" })], [NODE_DESCRIPTION]),
			h.div([h.Id("react-flow__edge-desc-1"), h.Style({ display: "none" })], [EDGE_DESCRIPTION]),
			h.div([
				h.Id("react-flow__aria-live-1"),
				h.AriaLive("assertive"),
				h.AriaAtomic(true),
				h.Style({
					position: "absolute",
					width: "1px",
					height: "1px",
					margin: "-1px",
					border: "0px",
					padding: "0px",
					overflow: "hidden",
					clip: "rect(0px, 0px, 0px, 0px)",
					"clip-path": "inset(100%)",
				}),
			]),
		],
	)

export const edgesLayer = <M>(h: HtmlBuilder<M>, edges: ReadonlyArray<Html>): Html =>
	h.div([h.Class("react-flow__edges")], edges)

export const nodesLayer = <M>(h: HtmlBuilder<M>, nodes: ReadonlyArray<Html>): Html =>
	h.div([h.Class("react-flow__nodes"), h.Style(FILL)], nodes)

/** `EdgeWrapper`: one `<svg>` per edge holding a focusable `group`. */
export const flowEdge = <M>(h: HtmlBuilder<M>, edge: FlowEdgeView): Html =>
	h.keyed("svg")(
		edge.id,
		[h.Style({ "z-index": "0" })],
		[
			h.g(
				[
					h.Class(
						`react-flow__edge react-flow__edge-${edge.type} nopan${edge.className ? ` ${edge.className}` : ""} inactive`,
					),
					h.DataAttribute("id", edge.id),
					h.DataAttribute("testid", `rf__edge-${edge.id}`),
					...(edge.focusable === false ? [h.Role("img")] : [h.Tabindex(0), h.Role("group")]),
					h.AriaLabel(`Edge from ${edge.source} to ${edge.target}`),
					h.Attribute("aria-roledescription", "edge"),
					...(edge.focusable === false ? [] : [h.AriaDescribedBy("react-flow__edge-desc-1")]),
				],
				edge.children,
			),
		],
	)
