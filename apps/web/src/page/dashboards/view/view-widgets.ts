import type { DashboardDocument } from "@maple/domain/http"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { isShareSupported } from "../kit/share-support"
import * as Menu from "../../../ui/menu"
import * as MenuView from "../../../ui/menu-view"
import { dataStateOf } from "../kit/data-state"
import type { VariableValues } from "@maple/query-engine"
import { type TileContext, widgetTile } from "../kit/tiles"
import { Message } from "./message"
import type { Model } from "./model"
import { slotOf } from "./plan"
import { errorDetailsIdOf, isEditing, widgetMenuIdOf } from "./update"
import { errorDetailsPopover } from "../kit/error-details"
import * as Popover from "../../../ui/popover"
import * as CopyButton from "../../../ui/copy-button"
import { isAlertable } from "./widget-actions"
import { moveValue } from "./move-target"

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
		...(isEdit && (model.document?.sections ?? []).length > 0 ? [moveToEntry(model, widget)] : []),
		...(isAlertable(widget)
			? [{ _tag: "Item", value: "alert", label: "Create alert", icon: "BellIcon" } as const]
			: []),
		...(model.shares === "Loaded" ? [embedEntry(widget)] : []),
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

/** "Embed chart"; a widget a shared view cannot render keeps it, disabled, with the reason. */
const embedEntry = (widget: Widget): MenuView.MenuItemEntry =>
	isShareSupported(widget.dataSource)
		? { _tag: "Item", value: "embed", label: "Embed chart", icon: "CodeIcon" }
		: {
				_tag: "Item",
				value: "embed",
				label: "Embed chart",
				icon: "CodeIcon",
				isDisabled: true,
				tooltip: { content: ["This widget can't be shown in shared views"], side: "left" },
			}

/** `MoveWidgetToSectionMenu`: Ungrouped, then every `Group · Tab`; where it lives now is disabled. */
const moveToEntry = (model: Model, widget: Widget): MenuView.MenuEntry => {
	const sections = model.document?.sections ?? []
	const inRoot = widget.sectionId === undefined || widget.tabId === undefined
	return {
		_tag: "Submenu",
		value: "move",
		label: "Move to",
		icon: "LayersIcon",
		separatorAfter: 0,
		entries: [
			{ _tag: "Item", value: moveValue(null), label: "Ungrouped", isDisabled: inRoot },
			...sections.flatMap((section) =>
				section.tabs.map((tab): MenuView.MenuItemEntry => ({
					_tag: "Item",
					value: moveValue({ sectionId: section.id, tabId: tab.id }),
					label: section.tabs.length === 1 ? section.title : `${section.title} · ${tab.title}`,
					isDisabled: widget.sectionId === section.id && widget.tabId === tab.id,
				})),
			),
		],
	}
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

/** The sparkline series of a stat, read like any tile's data (its own data source). */
const sparklineState = (model: Model, widget: Widget) => {
	const gate = slotOf(model, widget.id).sparkGate ?? null
	const source = widget.display.sparkline?.dataSource
	return gate === null || source === undefined
		? null
		: dataStateOf(model.requests, { ...widget, dataSource: source }, gate)
}

/** The view's tile context for one widget: its data, menu, chart and sort. */
export const tileContext = (
	h: H,
	model: Model,
	widget: Widget,
	timeZone: string,
	variables: VariableValues,
): TileContext<Message> => {
	const isEdit = isEditing(model)
	return {
		h,
		state: dataStateOf(model.requests, widget, slotOf(model, widget.id).gate),
		isEdit,
		menu: widgetMenu(h, model, widget),
		isMenuOpen: model.widgetMenuId === widget.id && model.widgetMenu.isOpen,
		hasGrip: true,
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
		sparkline: sparklineState(model, widget),
		narrowRange:
			slotOf(model, widget.id).gate?._tag === "Range" ? Message.ClickedNarrowRange({ widgetId: widget.id }) : null,
		variables,
		sparklineChart: model.charts[`${widget.id}:spark`] ?? Chart.init(),
		onSparklineChart: (message) => Message.GotChartMessage({ widgetId: `${widget.id}:spark`, message }),
		errorDetails: (message) =>
			errorDetailsPopover(h, {
				slotId: `error-details-${widget.id}`,
				popover: model.errorDetails[widget.id] ?? Popover.init(errorDetailsIdOf(widget.id)),
				copy: model.errorCopies[widget.id] ?? CopyButton.init(),
				message,
				onPopover: (inner) => Message.GotErrorDetailsMessage({ widgetId: widget.id, message: inner }),
				onCopy: (inner) => Message.GotErrorCopyMessage({ widgetId: widget.id, message: inner }),
			}),
	}
}

/** A tile of the open dashboard. */
export const viewTile = (h: H, model: Model, widget: Widget, timeZone: string, variables: VariableValues): Html =>
	widgetTile(h, tileContext(h, model, widget, timeZone, variables), widget)
