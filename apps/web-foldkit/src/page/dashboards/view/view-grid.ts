import { containerKeyOf, type DashboardDocument, ROOT_CONTAINER_KEY } from "@maple/domain/http"
import { normalizeLayout } from "@maple/grid-engine"
import { cn } from "@maple/ui/lib/utils"
import {
	GRID_ROW_HEIGHT,
	projectLayout,
	tierForWidth,
} from "@maple/web/components/dashboard-builder/canvas/grid-breakpoints"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { MeasureGrid, WatchWidget } from "./command"
import { Message } from "./message"
import { isEditing } from "./update"
import { GRID_INSTRUCTIONS_ID } from "./view-shell"
import { type TileContext, widgetTile } from "./view-widgets"

// `DashboardSections` + `DashboardGrid` (dashboard-builder/sections/dashboard-sections.tsx,
// canvas/dashboard-canvas.tsx): one measured container, CSS Grid placement per stored layout.
// TODO(sections): grouped widgets (sections and tabs) are not ported; only the root canvas draws.

type H = HtmlBuilder<Message>
type Widget = DashboardDocument["widgets"][number]

const resizeHandle = (h: H, widgetId: string): Html =>
	h.div([
		h.DataAttribute("grid-resize-handle", ""),
		h.AriaHidden(true),
		h.Class(
			"absolute right-0 bottom-0 size-5 cursor-se-resize touch-none opacity-0 transition-opacity group-hover/cell:opacity-100 group-[.is-layout-locked]/canvas:hidden after:absolute after:right-1 after:bottom-1 after:size-1.5 after:border-r-2 after:border-b-2 after:border-muted-foreground/60",
		),
		h.OnPointerDown((_pointerType, button, _sx, _sy, _t, clientX, clientY) =>
			button === 0
				? Option.some(Message.PressedResizeHandle({ widgetId, clientX, clientY }))
				: Option.none(),
		),
	])

/** `GridCell`: the tile in its cells, and (editing) the resize corner. */
const gridCell = (
	h: H,
	ctx: TileContext,
	widget: Widget,
	item: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
	isEditable: boolean,
): Html =>
	h.keyed("div")(
		widget.id,
		[
			h.DataAttribute("grid-item", widget.id),
			h.DataAttribute("grid-box", `${item.x},${item.y},${item.w},${item.h}`),
			h.Class("group/cell"),
			h.Style({
				position: "relative",
				"min-width": "0px",
				"grid-column": `${item.x + 1} / span ${item.w}`,
				"grid-row": `${item.y + 1} / span ${item.h}`,
			}),
		],
		[
			h.div(
				[h.Class("h-full w-full"), h.OnMount(WatchWidget({ widgetId: widget.id }))],
				[widgetTile(h, ctx, widget)],
			),
			...(isEditable ? [resizeHandle(h, widget.id)] : []),
		],
	)

const dashboardGrid = (h: H, ctx: TileContext, widgets: ReadonlyArray<Widget>, width: number): Html => {
	const tier = tierForWidth(width)
	const isEditable = isEditing(ctx.model) && tier.canonical
	const layout = normalizeLayout(
		projectLayout(widgets, tier),
		tier.cols,
		tier.canonical ? "vertical" : "none",
	)
	const byId = new Map(layout.map((item) => [item.i, item]))
	return h.div(
		[
			h.DataAttribute("dashboard-grid", ""),
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
			...widgets.flatMap((widget) => {
				const item = byId.get(widget.id)
				return item === undefined ? [] : [gridCell(h, ctx, widget, item, isEditable)]
			}),
			...(isEditable
				? [
						h.p(
							[h.Id(GRID_INSTRUCTIONS_ID), h.Hidden(true)],
							[
								"Press Space to pick up. Arrow keys move, Shift and arrow keys resize, Space drops, Escape cancels.",
							],
						),
						h.output([h.AriaLive("polite"), h.Class("sr-only")], []),
					]
				: []),
		],
	)
}

/** The measured canvas; grids draw once the width is known, so nothing paints on the wrong tier. */
export const dashboardSections = (h: H, ctx: TileContext, document: DashboardDocument): Html => {
	const width = ctx.model.gridWidth
	const tier = tierForWidth(width)
	const rootWidgets = document.widgets.filter((widget) => containerKeyOf(widget) === ROOT_CONTAINER_KEY)
	return h.div(
		[h.Class(cn("group/canvas", !tier.canonical && "is-layout-locked")), h.OnMount(MeasureGrid())],
		[
			...(isEditing(ctx.model) && !tier.canonical
				? [
						h.p(
							[h.Class("mb-3 text-xs text-muted-foreground")],
							[
								"Showing a layout adapted to this width. Widen the window to rearrange widgets.",
							],
						),
					]
				: []),
			...(width > 0 && rootWidgets.length > 0 ? [dashboardGrid(h, ctx, rootWidgets, width)] : []),
		],
	)
}
