import type { DashboardDocument } from "@maple/domain/http"
import type { GridItem } from "@maple/grid-engine"
import { cn } from "@maple/ui/lib/utils"
import { GRID_ROW_HEIGHT } from "../../../components/dashboard-builder/canvas/grid-breakpoints"
import type { Html, HtmlBuilder } from "foldkit/html"
import { GRID_INSTRUCTIONS_ID } from "../kit/tile-shell"
import { MeasureGrid, WatchGridHandles, WatchWidget } from "./command"
import { type CanvasGrid, canvasGridOf, rootWidgetsOf, shownLayoutOf } from "./grid"
import { Message } from "./message"
import type { Model } from "./model"
import { isEditing } from "./update"
import { viewTile } from "./view-widgets"
import type { VariableValues } from "@maple/query-engine"
import { sectionView } from "./view-sections"
import { resolveSectionView } from "../../../lib/dashboards/section-view-state"
import { containerKeyFor } from "@maple/domain/http"

// The dashboard sections and grid: one measured container, CSS Grid placement per stored layout.

type H = HtmlBuilder<Message>
type Widget = DashboardDocument["widgets"][number]

type TileContext = Readonly<{
	model: Model
	timeZone: string
	variables: VariableValues
	/** `renderWidget`: the tile drawn in each cell (the bench lab's stand-in), else the widget's own. */
	renderTile?: (widget: Widget) => Html
}>

const gridArea = (item: GridItem) => ({
	"grid-column": `${item.x + 1} / span ${item.w}`,
	"grid-row": `${item.y + 1} / span ${item.h}`,
})

const px = (value: number) => `${value}px`

const resizeHandle = (h: H): Html =>
	h.div([
		h.DataAttribute("grid-resize-handle", ""),
		h.AriaHidden(true),
		h.Class(
			"absolute right-0 bottom-0 size-5 cursor-se-resize touch-none opacity-0 transition-opacity group-hover/cell:opacity-100 group-[.is-layout-locked]/canvas:hidden after:absolute after:right-1 after:bottom-1 after:size-1.5 after:border-r-2 after:border-b-2 after:border-foreground-subtle",
		),
	])

/** `GridCell`: the tile in its cells (or lifted under the pointer), and (editing) the resize corner. */
const gridCell = (h: H, ctx: TileContext, widget: Widget, item: GridItem, isEditable: boolean): Html => {
	const gesture = ctx.model.gesture
	const lifted =
		gesture !== null && gesture.isStarted && gesture.kind === "drag" && gesture.widgetId === widget.id
			? gesture
			: null
	return h.keyed("div")(
		widget.id,
		[
			h.DataAttribute("grid-item", widget.id),
			h.DataAttribute("grid-box", `${item.x},${item.y},${item.w},${item.h}`),
			h.Class(
				cn(
					"group/cell",
					lifted !== null && "z-20 opacity-90 will-change-transform",
					ctx.model.keyboardMove?.widgetId === widget.id &&
						"z-10 rounded-lg outline-2 outline-offset-2 outline-primary",
				),
			),
			h.Style(
				lifted === null
					? { position: "relative", "min-width": "0px", ...gridArea(item) }
					: {
							position: "absolute",
							left: px(lifted.rect.left),
							top: px(lifted.rect.top),
							width: px(lifted.rect.width),
							height: px(lifted.rect.height),
							transform: `translate3d(${lifted.dx}px, ${lifted.dy}px, 0)`,
						},
			),
		],
		[
			h.div(
				[h.Class("h-full w-full"), h.OnMount(WatchWidget({ widgetId: widget.id }))],
				[ctx.renderTile?.(widget) ?? viewTile(h, ctx.model, widget, ctx.timeZone, ctx.variables)],
			),
			...(isEditable ? [resizeHandle(h)] : []),
		],
	)
}

/** `Placeholder` under a dragged tile, and the dashed resize ghost. */
const gestureLayers = (h: H, model: Model, shown: ReadonlyArray<GridItem>): ReadonlyArray<Html> => {
	const gesture = model.gesture
	if (gesture === null || !gesture.isStarted) return []
	if (gesture.kind === "resize")
		return [
			h.div([
				h.AriaHidden(true),
				h.Class(
					"pointer-events-none absolute z-20 rounded-lg border-2 border-dashed border-primary/60",
				),
				h.Style({
					left: px(gesture.rect.left),
					top: px(gesture.rect.top),
					width: px(Math.max(0, gesture.rect.width + gesture.dx)),
					height: px(Math.max(0, gesture.rect.height + gesture.dy)),
				}),
			]),
		]
	const item = shown.find((candidate) => candidate.i === gesture.widgetId)
	return item === undefined
		? []
		: [
				h.div([
					h.AriaHidden(true),
					h.DataAttribute("grid-placeholder", ""),
					h.Class("rounded-lg border border-dashed border-primary/60 bg-primary-a1"),
					h.Style(gridArea(item)),
				]),
			]
}

const dashboardGrid = (h: H, ctx: TileContext, grid: CanvasGrid): Html => {
	const { tier } = grid
	const isEditable = isEditing(ctx.model) && tier.canonical
	const shown = shownLayoutOf(ctx.model, grid)
	const byId = new Map(shown.map((item) => [item.i, item]))
	return h.div(
		[
			h.DataAttribute("dashboard-grid", ""),
			h.OnMount(WatchGridHandles()),
			h.Style({
				display: "grid",
				position: "relative",
				"grid-template-columns": `repeat(${tier.cols}, minmax(0, 1fr))`,
				"grid-auto-rows": `${GRID_ROW_HEIGHT}px`,
				"column-gap": `${tier.margin[0]}px`,
				"row-gap": `${tier.margin[1]}px`,
				"padding-block": `${tier.margin[1]}px`,
			}),
		],
		[
			...grid.widgets.flatMap((widget) => {
				const item = byId.get(widget.id)
				return item === undefined ? [] : [gridCell(h, ctx, widget, item, isEditable)]
			}),
			...(isEditable ? gestureLayers(h, ctx.model, shown) : []),
			...(isEditable
				? [
						h.p(
							[h.Id(GRID_INSTRUCTIONS_ID), h.Hidden(true)],
							[
								"Press Space to pick up. Arrow keys move, Shift and arrow keys resize, Space drops, Escape cancels.",
							],
						),
						h.output([h.AriaLive("polite"), h.Class("sr-only")], [ctx.model.gridAnnouncement]),
					]
				: []),
		],
	)
}

/** Each group in order; a collapsed one draws its header, an expanded one its active tab's grid. */
const sectionsOf = (h: H, ctx: TileContext, document: DashboardDocument): ReadonlyArray<Html> => {
	const sections = document.sections ?? []
	const view = resolveSectionView(sections, document.widgets, ctx.model.search)
	const isEditable = isEditing(ctx.model) && canvasGridOf(ctx.model)?.tier.canonical === true
	return sections.map((section, index) => {
		const activeTabId = view.activeTabs.get(section.id) ?? section.tabs[0]?.id ?? section.id
		const grid = canvasGridOf(ctx.model, containerKeyFor({ sectionId: section.id, tabId: activeTabId }))
		return sectionView(h, ctx.model, {
			section,
			index,
			sectionCount: sections.length,
			activeTabId,
			isCollapsed: view.collapsed.has(section.id),
			isEditable,
			grid: grid === null || grid.widgets.length === 0 ? null : dashboardGrid(h, ctx, grid),
		})
	})
}

/** The measured canvas; grids draw once the width is known, so nothing paints on the wrong tier. */
export const dashboardSections = (h: H, ctx: TileContext, document: DashboardDocument): Html => {
	const grid = canvasGridOf(ctx.model)
	const isLocked = grid !== null && !grid.tier.canonical
	return h.div(
		[
			h.Class(cn("group/canvas", (grid === null || isLocked) && "is-layout-locked")),
			h.OnMount(MeasureGrid()),
		],
		[
			...(isEditing(ctx.model) && (grid === null || isLocked)
				? [
						h.p(
							[h.Class("mb-3 text-xs text-muted-foreground")],
							[
								"Showing a layout adapted to this width. Widen the window to rearrange widgets.",
							],
						),
					]
				: []),
			...(grid !== null && rootWidgetsOf(document).length > 0 ? [dashboardGrid(h, ctx, grid)] : []),
			...(grid === null ? [] : sectionsOf(h, ctx, document)),
		],
	)
}
