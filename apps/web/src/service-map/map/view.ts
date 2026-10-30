import { Option } from "effect"
import { createLazy, type Html } from "foldkit/html"
import { button } from "../../ui/button"
import type * as Canvas from "../xyflow/canvas"
import { edgesLayer, flowCanvas, nodesLayer } from "../xyflow/view"
import { miniMapNodes, miniMapRectsLayer, particleLayer, renderEdges, renderNodes } from "./layers"
import { serviceMapLegend } from "./legend"
import { serviceMapLoading } from "./loading"
import { serviceMapBackground, serviceMapControls, serviceMapMiniMap } from "./panels"
import {
	Message,
	type Model,
	ServiceMapComposition,
	type ServiceMapViewBuilder,
	SplitBinding,
} from "./service-map"
import { serviceMapToolbar } from "./toolbar-view"

const nodesSlot = createLazy()
const edgesSlot = createLazy()
const rectsSlot = createLazy()
const particlesSlot = createLazy()

/** The map's own Messages need no wrapping inside its boundary; one identity keeps layers lazy. */
const toSelf = (message: Message): Message => message

export type MapViewOptions = Readonly<{
	/** The side panel for the selected node (`renderDetailPanel`). */
	detailPanel?: (selectedId: string) => Html
	/** Shown when the graph has no nodes at all. A thunk: viewInputs may only hold Html-building
	 *  functions at the top level, so they run in the host's boundary. */
	emptyState?: () => Html
	/** `viewMode`: in 3D the scene replaces the canvas, without presentation controls or legend. */
	viewMode?: "2d" | "3d"
	render3D?: () => Html
}>

/** Declutter hid every node: offer a reset instead of the "no instrumentation" empty state. */
const hiddenState = (h: ServiceMapViewBuilder, model: Model): Html =>
	h.div(
		[h.Class("flex h-full items-center justify-center")],
		[
			h.div(
				[h.Class("space-y-3 text-center")],
				[
					h.p(
						[h.Class("text-sm font-medium text-foreground")],
						["Everything is hidden by the current filters"],
					),
					h.p(
						[h.Class("text-xs text-muted-foreground")],
						[
							String(model.source.rawNodes.length),
							" services are below the traffic threshold or outside the focus.",
						],
					),
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedResetFilters())],
						},
						["Reset filters"],
					),
				],
			),
		],
	)

const toCanvas = (message: Canvas.Message): Message => Message.ReceivedCanvasMessage({ message })

const canvasArea = (h: ServiceMapViewBuilder, model: Model): Html => {
	const { graph, selectedId, colorMode, positions } = model
	const measured = model.canvas.measured
	const draggingId = Option.match(model.drag, { onNone: () => null, onSome: (drag) => drag.id })
	return flowCanvas(h, {
		model: model.canvas,
		toMessage: toCanvas,
		edges: edgesSlot(renderEdges, [h, graph, positions, measured]) ?? edgesLayer(h, []),
		nodes:
			nodesSlot(renderNodes, [
				h,
				graph,
				positions,
				measured,
				selectedId,
				colorMode,
				toSelf,
				draggingId,
			]) ?? nodesLayer(h, []),
		onPaneClick: Message.ClickedPane(),
		panels: [
			...(model.reducedMotion
				? []
				: [particlesSlot(particleLayer, [h, graph, positions, measured, toSelf]) ?? h.canvas([])]),
			serviceMapControls(h, model.canvas, toCanvas),
			serviceMapMiniMap(
				h,
				model.canvas,
				miniMapNodes(graph, positions, measured, selectedId, colorMode),
				rectsSlot(miniMapRectsLayer, [h, graph, positions, measured, selectedId, colorMode]) ??
					h.g([], []),
			),
			serviceMapBackground(h, model.canvas),
		],
	})
}

/** The map column: toolbar, canvas and legend. */
const mapColumn = (h: ServiceMapViewBuilder, model: Model, options: MapViewOptions): Html => {
	const is3d = options.viewMode === "3d"
	return h.div(
		[h.Class("flex flex-col h-full")],
		[
			serviceMapToolbar(h, {
				model: model.toolbar,
				focus: model.focus,
				services: model.source.services,
				minTrafficPct: model.minTrafficPct,
				colorMode: model.colorMode,
				hiddenNodeCount: model.graph.declutter.hiddenNodeCount,
				hiddenEdgeCount: model.graph.declutter.hiddenEdgeCount,
				showPresentationControls: !is3d,
			}),
			h.div(
				[h.Class("flex-1 min-h-0 relative")],
				[is3d ? (options.render3D?.() ?? h.div([], [])) : canvasArea(h, model)],
			),
			...(is3d ? [] : [serviceMapLegend(h, model.colorMode, model.source.services, model.legend)]),
		],
	)
}

/**
 * The map: empty or all-hidden state, the loading skeleton until the first layout lands, then
 * the split of map column and the selected node's panel. Its inputs' callbacks run in the host.
 */
export const view = ServiceMapComposition.makeView.withInputs<MapViewOptions>((model, options, h) => {
	if (model.graph.nodes.length === 0) {
		if (model.source.rawNodes.length > 0) return hiddenState(h, model)
		return options.emptyState?.() ?? h.div([], [])
	}
	if (!model.revealed && options.viewMode !== "3d") return serviceMapLoading(h)
	const detail = Option.flatMap(model.selectedId, (id) =>
		options.detailPanel === undefined ? Option.none() : Option.some(options.detailPanel(id)),
	)
	return h.div(
		[h.Class("flex flex-col h-full"), h.DataAttribute("elk-status", model.layout.status)],
		[
			h.block(
				SplitBinding.embedView({
					slotId: "service-map-split",
					model: model.split,
					viewInputs: {
						className: "flex-1 min-h-0",
						withHandle: [true],
						toPanels: () => [
							[mapColumn(h, model, options)],
							...Option.toArray(Option.map(detail, (panel) => [panel])),
						],
					},
				}),
			),
		],
	)
})
