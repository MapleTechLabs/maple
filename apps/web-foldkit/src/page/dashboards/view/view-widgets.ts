import type { DashboardDocument } from "@maple/domain/http"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import * as Menu from "../../../ui/menu"
import * as MenuView from "../../../ui/menu-view"
import { dataStateOf } from "../kit/data-state"
import { type TileContext, widgetTile } from "../kit/tiles"
import { Message } from "./message"
import type { Model } from "./model"
import { slotOf } from "./plan"
import { isEditing, widgetMenuIdOf } from "./update"
import { isAlertable } from "./widget-actions"

// The open dashboard's tiles: their actions menu and the context the shared tiles read.

type H = HtmlBuilder<Message>
type Widget = DashboardDocument["widgets"][number]

// MENU

const widgetMenuEntries = (model: Model, widget: Widget): ReadonlyArray<MenuView.MenuEntry> => {
	const isEdit = isEditing(model)
	const entries: ReadonlyArray<MenuView.MenuEntry> = [
		...(isEdit
			? [
					{ _tag: "Item", value: "edit", label: "Edit", icon: "PencilIcon" } as const,
					{ _tag: "Item", value: "clone", label: "Clone", icon: "CopyIcon" } as const,
				]
			: []),
		...(isAlertable(widget)
			? [{ _tag: "Item", value: "alert", label: "Create alert", icon: "BellIcon" } as const]
			: []),
		// TODO(embed): "Embed chart" opens the embed dialog, which is not ported; the item is inert.
		...(model.shares === "Loaded"
			? [{ _tag: "Item", value: "embed", label: "Embed chart", icon: "CodeIcon" } as const]
			: []),
		...(isEdit
			? [
					{ _tag: "Separator" } as const,
					{
						_tag: "Item",
						value: "delete",
						label: "Delete",
						icon: "TrashIcon",
						variant: "destructive",
					} as const,
				]
			: []),
	]
	return entries
}

/** The tile's "Widget actions" kebab; only the active tile holds live menu state. */
const widgetMenu = (h: H, model: Model, widget: Widget): Html | null => {
	const entries = widgetMenuEntries(model, widget)
	if (entries.length === 0) return null
	const menu = model.widgetMenuId === widget.id ? model.widgetMenu : Menu.init(widgetMenuIdOf(widget.id))
	return h.submodel({
		slotId: `widget-menu-${widget.id}`,
		model: menu,
		view: MenuView.view,
		viewInputs: {
			entries,
			align: "end",
			className: "w-max",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								variant: "ghost",
								size: "icon-xs",
								attributes: [h.AriaLabel("Widget actions"), ...trigger],
							},
							[icon(h, "DotsVerticalIcon")],
						),
					),
				),
		},
		toParentMessage: (message) => Message.GotWidgetMenuMessage({ widgetId: widget.id, message }),
	})
}

/** The view's tile context for one widget: its data, menu, chart and sort. */
export const tileContext = (h: H, model: Model, widget: Widget, timeZone: string): TileContext<Message> => {
	const isEdit = isEditing(model)
	return {
		h,
		state: dataStateOf(model.requests, widget, slotOf(model, widget.id).gate),
		isEdit,
		menu: widgetMenu(h, model, widget),
		isMenuOpen: model.widgetMenuId === widget.id && model.widgetMenu.isOpen,
		onGripDown: (clientX, clientY) => Message.PressedGrip({ widgetId: widget.id, clientX, clientY }),
		configure: isEdit
			? Message.GotWidgetMenuMessage({
					widgetId: widget.id,
					message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value: "edit" } }),
				})
			: null,
		chart: model.charts[widget.id] ?? Chart.init(),
		themeColors: model.themeColors,
		chartRuntime: model.chartRuntime,
		nowMs: model.nowMs,
		timeZone,
		tableSort: model.tableSorts[widget.id] ?? { key: null, dir: "desc" },
		onChart: (message) => Message.GotChartMessage({ widgetId: widget.id, message }),
		onSort: (field, isText) => Message.ClickedSortColumn({ widgetId: widget.id, field, isText }),
	}
}

/** A tile of the open dashboard. */
export const viewTile = (h: H, model: Model, widget: Widget, timeZone: string): Html =>
	widgetTile(h, tileContext(h, model, widget, timeZone), widget)
