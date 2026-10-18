import { containerKeyOf, type DashboardDocument, ROOT_CONTAINER_KEY } from "@maple/domain/http"
import { type GridGeometry, type Layout, normalizeLayout } from "@maple/grid-engine"
import {
	GRID_ROW_HEIGHT,
	type GridTier,
	projectLayout,
	tierForWidth,
} from "@maple/web/components/dashboard-builder/canvas/grid-breakpoints"
import type { Model } from "./model"

// The root canvas's grid as `DashboardGrid` derives it: the tier for the measured width, the
// stored layout projected onto it, and the pixel geometry a gesture resolves cells with.

type Widget = DashboardDocument["widgets"][number]

export type CanvasGrid = Readonly<{
	tier: GridTier
	widgets: ReadonlyArray<Widget>
	/** `projectLayout`: what is stored, before compaction; a commit diffs against this. */
	stored: Layout
	/** `normalizeLayout`: what the grid draws while nobody is interacting. */
	layout: Layout
	geometry: GridGeometry
}>

export const rootWidgetsOf = (document: DashboardDocument): ReadonlyArray<Widget> =>
	document.widgets.filter((widget) => containerKeyOf(widget) === ROOT_CONTAINER_KEY)

export const canvasGridOf = (model: Model): CanvasGrid | null => {
	if (model.document === null || model.gridWidth <= 0) return null
	const tier = tierForWidth(model.gridWidth)
	const widgets = rootWidgetsOf(model.document)
	const stored = projectLayout(widgets, tier)
	return {
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

/** What the grid draws now: a live gesture's preview, a just-dropped layout, or the stored one. */
export const shownLayoutOf = (model: Model, grid: CanvasGrid): Layout =>
	model.gesture !== null && model.gesture.isStarted
		? model.gesture.preview
		: model.keyboardMove !== null
			? model.keyboardMove.preview
			: (model.droppedLayout ?? grid.layout)
