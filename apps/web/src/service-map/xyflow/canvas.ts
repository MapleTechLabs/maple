import { Option, Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { INITIAL_VIEWPORT, MeasuredNode, type PlacedNode, Point, Viewport } from "./geometry"
import { fitViewport, scaleViewport } from "./viewport"

/**
 * The state `<ReactFlow>` keeps in its store, as a Foldkit Submodel: the camera, the pane size,
 * each node's measured size and handles, and whether a fit is waiting for measurements.
 * The parent owns the nodes; `update` takes their positions so fits can frame them.
 */

export const FitRequest = Schema.Struct({
	padding: Schema.Number,
	minZoom: Schema.Number,
	maxZoom: Schema.Number,
	/** `fitView({ duration })`: animated by d3 in the Mount; 0 or absent snaps. */
	duration: Schema.optionalKey(Schema.Number),
})
export type FitRequest = typeof FitRequest.Type

export const Model = Schema.Struct({
	viewport: Viewport,
	pane: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
	/** The zoom extent: the pane's fractional box (`XYPanZoom`'s cached extent). */
	extent: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
	measured: Schema.Record(Schema.String, MeasuredNode),
	/** A fit to run once every node is measured (React Flow's `fitView` prop / queued `fitView`). */
	pendingFit: Schema.Option(FitRequest),
	/** Set by a pan or zoom gesture; the trace flow view stops refitting on resize after one. */
	movedByUser: Schema.Boolean,
	minZoom: Schema.Number,
	maxZoom: Schema.Number,
	/** How many fits have been applied. */
	fitsApplied: Schema.Number,
	/** A change asks the Mount to re-measure every node at the current zoom (see {@link remeasure}). */
	measureEpoch: Schema.Number,
	/** An animated camera move for the Mount to run through d3 (`setViewport({ duration })`). */
	animation: Schema.Option(
		Schema.Struct({ seq: Schema.Number, target: Viewport, duration: Schema.Number }),
	),
})
export type Model = typeof Model.Type

/**
 * Re-measure every node now. React Flow re-measures whenever node objects lose `measured`, and
 * it measures handles relative to the zoom of that moment; hosts that do so call this to land on
 * the same sub-pixel handle positions.
 */
export const remeasure = (model: Model): Model => modifyFields(model, { measureEpoch: (epoch) => epoch + 1 })

export const init = (config: {
	readonly minZoom: number
	readonly maxZoom: number
	readonly fitOnInit: Option.Option<FitRequest>
}): Model => ({
	viewport: INITIAL_VIEWPORT,
	pane: { width: 0, height: 0 },
	extent: { width: 0, height: 0 },
	measured: {},
	pendingFit: config.fitOnInit,
	movedByUser: false,
	minZoom: config.minZoom,
	maxZoom: config.maxZoom,
	fitsApplied: 0,
	measureEpoch: 0,
	animation: Option.none(),
})

export const Message = defineMessageUnion({
	ChangedViewport: { viewport: Viewport },
	/**
	 * `width`/`height` are the pane's offset size (React Flow's store, what fits frame); `extent` is
	 * its fractional box, the zoom extent XYPanZoom caches and zooms around.
	 */
	ResizedPane: {
		width: Schema.Number,
		height: Schema.Number,
		extent: Schema.optionalKey(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
	},
	MeasuredNodes: { nodes: Schema.Array(MeasuredNode) },
	ClickedZoomIn: {},
	ClickedZoomOut: {},
	ClickedFitView: {},
	/** A node drag moved (`XYDrag`); the parent owns positions. */
	DraggedNode: { id: Schema.String, position: Point },
	EndedNodeDrag: { id: Schema.String, position: Point },
	/** A pan or zoom gesture ended (`onMoveEnd`). */
	EndedViewportMove: {},
})
export type Message = typeof Message.Type

export const placed = (
	model: Model,
	nodes: ReadonlyArray<{
		readonly id: string
		readonly position: { readonly x: number; readonly y: number }
	}>,
): ReadonlyArray<PlacedNode> => nodes.map((node) => ({ ...node, measured: model.measured[node.id] }))

/** Runs `request` now if every node is measured and the pane has a size, else keeps it queued. */
export const requestFit = (model: Model, nodes: ReadonlyArray<PlacedNode>, request: FitRequest): Model => {
	const ready =
		model.pane.width > 0 && nodes.length > 0 && nodes.every((node) => node.measured !== undefined)
	if (!ready) return modifyFields(model, { pendingFit: () => Option.some(request) })
	const viewport = fitViewport(nodes, model.pane, request)
	const duration = request.duration ?? 0
	if (duration > 0 && viewport !== undefined)
		return modifyFields(model, {
			animation: (animation) =>
				Option.some({
					seq: Option.match(animation, { onNone: () => 1, onSome: (a) => a.seq + 1 }),
					target: viewport,
					duration,
				}),
			pendingFit: () => Option.none(),
			fitsApplied: (count) => count + 1,
		})
	return modifyFields(model, {
		viewport: () => viewport ?? model.viewport,
		pendingFit: () => Option.none(),
		fitsApplied: (count) => count + 1,
	})
}

const resolvePendingFit = (model: Model, nodes: ReadonlyArray<PlacedNode>): Model =>
	Option.match(model.pendingFit, {
		onNone: () => model,
		onSome: (request) => requestFit(model, nodes, request),
	})

/** React Flow's `zoomIn` / `zoomOut` step. */
const ZOOM_STEP = 1.2

type NodePositions = ReadonlyArray<{
	readonly id: string
	readonly position: { readonly x: number; readonly y: number }
}>

/**
 * `nodes` are the parent's positioned nodes; `extra` adds already-measured rects a fit must frame
 * too (nodes React Flow knows that the parent derives, such as the service map's namespace boxes).
 */
export const update = (
	model: Model,
	message: Message,
	nodes: NodePositions,
	extra: (canvas: Model) => ReadonlyArray<PlacedNode> = () => [],
): Model =>
	Message.match<Model>(message, {
		ChangedViewport: ({ viewport }) =>
			modifyFields(model, { viewport: () => viewport, movedByUser: () => true }),
		ResizedPane: ({ width, height, extent }) => {
			const next = modifyFields(model, {
				pane: () => ({ width, height }),
				extent: () => extent ?? { width, height },
			})
			return resolvePendingFit(next, [...placed(next, nodes), ...extra(next)])
		},
		MeasuredNodes: ({ nodes: measurements }) => {
			const measured = { ...model.measured }
			for (const node of measurements) measured[node.id] = node
			const next = modifyFields(model, { measured: () => measured })
			return resolvePendingFit(next, [...placed(next, nodes), ...extra(next)])
		},
		ClickedZoomIn: () =>
			modifyFields(model, {
				viewport: () => scaleViewport(model.viewport, ZOOM_STEP, model.extent, model),
			}),
		ClickedZoomOut: () =>
			modifyFields(model, {
				viewport: () => scaleViewport(model.viewport, 1 / ZOOM_STEP, model.extent, model),
			}),
		ClickedFitView: () =>
			requestFit(model, [...placed(model, nodes), ...extra(model)], {
				padding: 0.1,
				minZoom: model.minZoom,
				maxZoom: model.maxZoom,
			}),
		// The parent owns node positions and the persisted camera.
		DraggedNode: () => model,
		EndedNodeDrag: () => model,
		EndedViewportMove: () => model,
	})
