import { containerKeyOf, type DashboardDocument, ROOT_CONTAINER_KEY } from "@maple/domain/http"
import { type GridGeometry, type Layout, normalizeLayout } from "@maple/grid-engine"
import {
	GRID_ROW_HEIGHT,
	type GridTier,
	projectLayout,
	tierForWidth,
} from "../../../components/dashboard-builder/canvas/grid-breakpoints"
import type { Model } from "./model"

// One container's grid as `DashboardGrid` derives it (the root canvas, or a section tab): the tier
// for the one measured width every grid shares, the stored layout projected onto it, and the pixel
// geometry a gesture resolves cells with.

type Widget = DashboardDocument["widgets"][number]

export type CanvasGrid = Readonly<{
	/** `containerKeyOf`: which grid this is. */
	key: string
	tier: GridTier
	widgets: ReadonlyArray<Widget>
	/** `projectLayout`: what is stored, before compaction; a commit diffs against this. */
	stored: Layout
	/** `normalizeLayout`: what the grid draws while nobody is interacting. */
	layout: Layout
	geometry: GridGeometry
}>

export const widgetsOfContainer = (document: DashboardDocument, key: string): ReadonlyArray<Widget> =>
	document.widgets.filter((widget) => containerKeyOf(widget) === key)

export const rootWidgetsOf = (document: DashboardDocument): ReadonlyArray<Widget> =>
	widgetsOfContainer(document, ROOT_CONTAINER_KEY)

export const canvasGridOf = (model: Model, key: string = ROOT_CONTAINER_KEY): CanvasGrid | null => {
	if (model.document === null || model.gridWidth <= 0) return null
	const tier = tierForWidth(model.gridWidth)
	const widgets = widgetsOfContainer(model.document, key)
	const stored = projectLayout(widgets, tier)
	return {
		key,
		tier,
		widgets,
		stored,
		layout: normalizeLayout(stored, tier.cols, tier.canonical ? "vertical" : "none"),
		geometry: {
			width: model.gridWidth,
			cols: tier.cols,
			rowHeight: GRID_ROW_HEIGHT,
			gap: tier.margin,
			padding: [0, tier.margin[1]],
		},
	}
}

/** The grid a widget sits in: gestures and keyboard moves stay inside their own container. */
export const gridOfWidget = (model: Model, widgetId: string): CanvasGrid | null => {
	const widget = model.document?.widgets.find((candidate) => candidate.id === widgetId)
	return widget === undefined ? null : canvasGridOf(model, containerKeyOf(widget))
}

const holds = (grid: CanvasGrid, widgetId: string) => grid.widgets.some((widget) => widget.id === widgetId)

/** What the grid draws now: a live gesture's preview, a just-dropped layout, or the stored one. */
export const shownLayoutOf = (model: Model, grid: CanvasGrid): Layout =>
	model.gesture !== null && model.gesture.isStarted && holds(grid, model.gesture.widgetId)
		? model.gesture.preview
		: model.keyboardMove !== null && holds(grid, model.keyboardMove.widgetId)
			? model.keyboardMove.preview
			: model.droppedLayout !== null && model.droppedKey === grid.key
				? model.droppedLayout
				: grid.layout
