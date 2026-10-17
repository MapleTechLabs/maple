import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import type * as Canvas from "../xyflow/canvas"
import { edgesLayer, flowCanvas, nodesLayer } from "../xyflow/view"
import { miniMapNodes, miniMapRectsLayer, particleLayer, renderEdges, renderNodes } from "./layers"
import { serviceMapLegend } from "./legend"
import { serviceMapLoading } from "./loading"
import { serviceMapBackground, serviceMapControls, serviceMapMiniMap } from "./panels"
import { Message, type Model } from "./service-map"
import { serviceMapToolbar } from "./toolbar"

const nodesSlot = createLazy()
const edgesSlot = createLazy()
const rectsSlot = createLazy()
const particlesSlot = createLazy()

const PANEL_STYLE = {
	"min-height": "0px",
	"max-height": "100%",
	height: "auto",
	"min-width": "0px",
	"max-width": "100%",
	width: "auto",
	border: "0px",
	padding: "0px",
	margin: "0px",
	display: "flex",
	flex: "100 1 0px",
	overflow: "visible",
}

/** react-resizable-panels' group and its single panel, as rendered with nothing selected. */
const panelGroup = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div(
		[
			h.Class("flex h-full w-full aria-[orientation=vertical]:flex-col flex-1 min-h-0"),
			h.DataAttribute("group", "true"),
			h.DataAttribute("slot", "resizable-panel-group"),
			h.Style({
				height: "100%",
				width: "100%",
				overflow: "hidden",
				display: "flex",
				"flex-flow": "row",
				"touch-action": "pan-y",
			}),
		],
		[
			h.div(
				[
					h.DataAttribute("panel", "true"),
					h.DataAttribute("slot", "resizable-panel"),
					h.Style(PANEL_STYLE),
				],
				[
					h.div(
						[
							h.Class("min-w-0"),
							h.Style({
								"max-height": "100%",
								"max-width": "100%",
								"flex-grow": "1",
								overflow: "auto",
								"touch-action": "pan-y",
							}),
						],
						[h.div([h.Class("flex flex-col h-full")], children)],
					),
				],
			),
		],
	)

/** The map: loading skeleton until the first layout lands, then toolbar, canvas and legend. */
export const view = <M>(h: HtmlBuilder<M>, model: Model, toMessage: (message: Message) => M): Html => {
	if (!model.revealed) return serviceMapLoading(h)
	const toCanvas = (message: Canvas.Message) => toMessage(Message.GotCanvasMessage({ message }))
	const { graph, selectedId, colorMode } = model
	const positions = model.layout.positions
	const measured = model.canvas.measured
	const minimapNodes = miniMapNodes(graph, positions, measured, selectedId, colorMode)
	return h.div(
		[h.Class("flex flex-col h-full"), h.DataAttribute("elk-status", model.layout.status)],
		[
			panelGroup(h, [
				serviceMapToolbar(h, toMessage(Message.ClickedResort())),
				h.div(
					[h.Class("flex-1 min-h-0 relative")],
					[
						flowCanvas(h, {
							model: model.canvas,
							toMessage: toCanvas,
							edges:
								edgesSlot(renderEdges, [h, graph, positions, measured]) ?? edgesLayer(h, []),
							nodes:
								nodesSlot(renderNodes, [
									h,
									graph,
									positions,
									measured,
									selectedId,
									colorMode,
									toMessage,
								]) ?? nodesLayer(h, []),
							onPaneClick: toMessage(Message.ClickedPane()),
							panels: [
								...(model.reducedMotion
									? []
									: [
											particlesSlot(particleLayer, [
												h,
												graph,
												positions,
												measured,
												toMessage,
											]) ?? h.canvas([]),
										]),
								serviceMapControls(h, model.canvas, toCanvas),
								serviceMapMiniMap(
									h,
									model.canvas,
									minimapNodes,
									rectsSlot(miniMapRectsLayer, [
										h,
										graph,
										positions,
										measured,
										selectedId,
										colorMode,
									]) ?? h.g([], []),
								),
								serviceMapBackground(h, model.canvas),
							],
						}),
					],
				),
				serviceMapLegend(h, colorMode, model.source.services),
			]),
		],
	)
}
