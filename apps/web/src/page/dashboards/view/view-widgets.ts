import type { DashboardDocument } from "@maple/domain/http"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
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
import type { Model, WidgetSlot } from "./model"
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

type Sections = NonNullable<DashboardDocument["sections"]>

/**
 * Everything one tile reads from the page model. Kept by reference while every field is, so the
 * tile's memo skips renders caused by another tile's data, menu or chart.
 */
type TileInputs = Readonly<{
	slot: WidgetSlot
	request: Model["requests"][string] | undefined
	sparkRequest: Model["requests"][string] | undefined
	isEdit: boolean
	/** The "Move to" targets; only read while editing. */
	sections: Sections | undefined
	isSharesLoaded: boolean
	/** The open actions menu, when it is this tile's. */
	menu: Menu.Model | null
	chart: Chart.Model | undefined
	sparklineChart: Chart.Model | undefined
	themeColors: Model["themeColors"]
	chartRuntime: Model["chartRuntime"]
	nowMs: Model["nowMs"]
	tableSort: Model["tableSorts"][string] | undefined
	errorDetails: Model["errorDetails"][string] | undefined
	errorCopy: Model["errorCopies"][string] | undefined
}>

const requestKeyOf = (gate: WidgetSlot["gate"] | undefined) =>
	gate?._tag === "Request" ? gate.request.key : null

const requestOf = (model: Model, gate: WidgetSlot["gate"] | undefined) => {
	const key = requestKeyOf(gate)
	return key === null ? undefined : model.requests[key]
}

const tileInputsOf = (model: Model, widget: Widget): TileInputs => {
	const slot = slotOf(model, widget.id)
	const isEdit = isEditing(model)
	return {
		slot,
		request: requestOf(model, slot.gate),
		sparkRequest: requestOf(model, slot.sparkGate),
		isEdit,
		sections: isEdit ? model.document?.sections : undefined,
		isSharesLoaded: model.shares === "Loaded",
		menu: model.widgetMenuId === widget.id ? model.widgetMenu : null,
		chart: model.charts[widget.id],
		sparklineChart: model.charts[`${widget.id}:spark`],
		themeColors: model.themeColors,
		chartRuntime: model.chartRuntime,
		nowMs: model.nowMs,
		tableSort: model.tableSorts[widget.id],
		errorDetails: model.errorDetails[widget.id],
		errorCopy: model.errorCopies[widget.id],
	}
}

/** The request slots a tile's gates point at, as `dataStateOf` reads them. */
const requestsOf = (inputs: TileInputs): Model["requests"] => {
	const key = requestKeyOf(inputs.slot.gate)
	const sparkKey = requestKeyOf(inputs.slot.sparkGate)
	return {
		...(key === null || inputs.request === undefined ? undefined : { [key]: inputs.request }),
		...(sparkKey === null || inputs.sparkRequest === undefined
			? undefined
			: { [sparkKey]: inputs.sparkRequest }),
	}
}

// MENU

const widgetMenuEntries = (inputs: TileInputs, widget: Widget): ReadonlyArray<MenuView.MenuEntry> => {
	const isEdit = inputs.isEdit
	const sections = inputs.sections ?? []
	const entries: ReadonlyArray<MenuView.MenuEntry> = [
		...(isEdit
			? [
					{ _tag: "Item", value: "edit", label: "Edit", icon: "PencilIcon" } as const,
					{ _tag: "Item", value: "clone", label: "Clone", icon: "CopyIcon" } as const,
				]
			: []),
		...(isEdit && sections.length > 0 ? [moveToEntry(sections, widget)] : []),
		...(isAlertable(widget)
			? [{ _tag: "Item", value: "alert", label: "Create alert", icon: "BellIcon" } as const]
			: []),
		...(inputs.isSharesLoaded ? [embedEntry(widget)] : []),
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
const moveToEntry = (sections: Sections, widget: Widget): MenuView.MenuEntry => {
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
const widgetMenu = (h: H, inputs: TileInputs, widget: Widget): Html | null => {
	const entries = widgetMenuEntries(inputs, widget)
	if (entries.length === 0) return null
	const menu = inputs.menu ?? Menu.init(widgetMenuIdOf(widget.id))
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
const sparklineState = (inputs: TileInputs, widget: Widget) => {
	const gate = inputs.slot.sparkGate ?? null
	const source = widget.display.sparkline?.dataSource
	return gate === null || source === undefined
		? null
		: dataStateOf(requestsOf(inputs), { ...widget, dataSource: source }, gate)
}

const contextOf = (
	h: H,
	inputs: TileInputs,
	widget: Widget,
	timeZone: string,
	variables: VariableValues,
): TileContext<Message> => ({
	h,
	state: dataStateOf(requestsOf(inputs), widget, inputs.slot.gate),
	isEdit: inputs.isEdit,
	menu: widgetMenu(h, inputs, widget),
	isMenuOpen: inputs.menu?.isOpen === true,
	hasGrip: true,
	configure: inputs.isEdit
		? Message.GotWidgetMenuMessage({
				widgetId: widget.id,
				message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value: "edit" } }),
			})
		: null,
	chart: inputs.chart ?? Chart.init(),
	themeColors: inputs.themeColors,
	chartRuntime: inputs.chartRuntime,
	nowMs: inputs.nowMs,
	timeZone,
	tableSort: inputs.tableSort ?? { key: null, dir: "desc" },
	onChart: (message) => Message.GotChartMessage({ widgetId: widget.id, message }),
	onSort: (field, isText) => Message.ClickedSortColumn({ widgetId: widget.id, field, isText }),
	sparkline: sparklineState(inputs, widget),
	narrowRange:
		inputs.slot.gate?._tag === "Range" ? Message.ClickedNarrowRange({ widgetId: widget.id }) : null,
	variables,
	sparklineChart: inputs.sparklineChart ?? Chart.init(),
	onSparklineChart: (message) => Message.GotChartMessage({ widgetId: `${widget.id}:spark`, message }),
	errorDetails: (message) =>
		errorDetailsPopover(h, {
			slotId: `error-details-${widget.id}`,
			popover: inputs.errorDetails ?? Popover.init(errorDetailsIdOf(widget.id)),
			copy: inputs.errorCopy ?? CopyButton.init(),
			message,
			onPopover: (inner) => Message.GotErrorDetailsMessage({ widgetId: widget.id, message: inner }),
			onCopy: (inner) => Message.GotErrorCopyMessage({ widgetId: widget.id, message: inner }),
		}),
})

/** The view's tile context for one widget: its data, menu, chart and sort. */
export const tileContext = (
	h: H,
	model: Model,
	widget: Widget,
	timeZone: string,
	variables: VariableValues,
): TileContext<Message> => contextOf(h, tileInputsOf(model, widget), widget, timeZone, variables)

// MEMO

const sameFields = (a: TileInputs, b: TileInputs): boolean => {
	const before = Object.values(a)
	const after = Object.values(b)
	return before.length === after.length && before.every((value, index) => value === after[index])
}

type TileMemo = Readonly<{ lazy: ReturnType<typeof createLazy>; inputs: TileInputs }>

/** One memo slot per tile; bounded so visiting many boards does not keep every old tile alive. */
const tileMemos = new Map<string, TileMemo>()
const MAX_TILE_MEMOS = 256

/** The board's variables keep their object while their values do: a fresh one per render would miss every tile. */
let lastVariables: Readonly<{ json: string; values: VariableValues }> | null = null
const stableVariables = (values: VariableValues): VariableValues => {
	const json = JSON.stringify(values)
	if (lastVariables?.json === json) return lastVariables.values
	lastVariables = { json, values }
	return values
}

const renderTile = (
	h: H,
	widget: Widget,
	inputs: TileInputs,
	timeZone: string,
	variables: VariableValues,
): Html => widgetTile(h, contextOf(h, inputs, widget, timeZone, variables), widget)

/** A tile of the open dashboard; it re-renders only when something it reads changed. */
export const viewTile = (
	h: H,
	model: Model,
	widget: Widget,
	timeZone: string,
	variables: VariableValues,
): Html => {
	const next = tileInputsOf(model, widget)
	const memo = tileMemos.get(widget.id)
	if (memo === undefined && tileMemos.size >= MAX_TILE_MEMOS) tileMemos.clear()
	const lazy = memo?.lazy ?? createLazy()
	const inputs = memo !== undefined && sameFields(memo.inputs, next) ? memo.inputs : next
	if (memo?.inputs !== inputs) tileMemos.set(widget.id, { lazy, inputs })
	return lazy(renderTile, [h, widget, inputs, timeZone, stableVariables(variables)]) ?? h.div([], [])
}
