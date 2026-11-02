import { resolveRefreshIntervalSeconds } from "../../../lib/dashboard-controls/search-params"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import type * as MenuView from "../../../ui/menu-view"
import { rowActionsMenu } from "../../../ui/row-actions-menu"
import { refreshControls as sharedRefreshControls } from "../../kit/refresh-controls"
import { presetLabel } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { Message } from "./message"
import type { Model } from "./model"
import { isEditing } from "./update"
import { variableSelects } from "./view-variables"
import type { PageContext } from "../../contract"

// The dashboard toolbar and `RefreshControls`.

type H = HtmlBuilder<Message>

const refreshControls = (h: H, model: Model): Html =>
	sharedRefreshControls(h, {
		seconds: resolveRefreshIntervalSeconds(model.search.refresh, model.document?.refreshIntervalSeconds),
		savedDefault: model.document?.refreshIntervalSeconds,
		isReloading: model.isReloading,
		onReload: Message.ClickedReload(),
		menu: model.refreshMenu,
		toMenuMessage: (message) => Message.GotRefreshMenuMessage({ message }),
	})

const moreEntries = (isEdit: boolean): ReadonlyArray<MenuView.MenuEntry> => [
	...(isEdit
		? ([
				{
					_tag: "Item",
					value: "auto-layout",
					label: "Auto layout",
					icon: "GridIcon",
					className: "whitespace-nowrap",
				},
				{
					_tag: "Item",
					value: "add-group",
					label: "Add group",
					icon: "LayersIcon",
					className: "whitespace-nowrap",
				},
				{
					_tag: "Item",
					value: "variables",
					label: "Variables",
					icon: "BracketsCurlyIcon",
					className: "whitespace-nowrap",
				},
				{
					_tag: "Item",
					value: "tags",
					label: "Tags",
					icon: "TagIcon",
					className: "whitespace-nowrap",
				},
			] as const)
		: []),
	{
		_tag: "Item",
		value: "history",
		label: "Version history",
		icon: "HistoryIcon",
		className: "whitespace-nowrap",
	},
	{ _tag: "Separator" },
	{ _tag: "Item", value: "share", label: "Share…", icon: "LinkIcon", className: "whitespace-nowrap" },
	{
		_tag: "Item",
		value: "export",
		label: "Export as JSON",
		icon: "DownloadIcon",
		className: "whitespace-nowrap",
	},
]

/** `RowActionsMenu label="More dashboard actions"`. */
const moreMenu = (h: H, model: Model): Html =>
	rowActionsMenu(h, {
		slotId: model.moreMenu.id,
		model: model.moreMenu,
		entries: moreEntries(isEditing(model)),
		label: "More dashboard actions",
		toParentMessage: (message) => Message.GotMoreMenuMessage({ message }),
	})

const timeLabel = (model: Model): string =>
	model.timeRange === null
		? ""
		: model.timeRange.type === "relative"
			? presetLabel(model.timeRange.value)
			: `${model.timeRange.startTime} - ${model.timeRange.endTime}`

export const toolbar = (h: H, model: Model, context: PageContext): Html => {
	const timeZone = context.timeZone
	const isEdit = isEditing(model)
	const isReadOnly = model.persistenceError !== null || model.history.previewed !== null
	return h.div(
		[h.Class("flex flex-wrap items-center justify-end gap-2 @min-[720px]/page:gap-3")],
		[
			h.div(
				[h.Class("flex min-w-0 max-w-full items-center overflow-x-auto")],
				variableSelects(h, model, context, isEdit && !isReadOnly),
			),
			h.submodel({
				slotId: "dashboard-time-picker",
				model: model.timePicker,
				view: TimeRangePicker.view,
				viewInputs: {
					label: timeLabel(model),
					selectedPreset: model.timeRange?.type === "relative" ? model.timeRange.value : undefined,
					presets: TimeRangePicker.PRESET_VALUES,
					timeZone,
				},
				toParentMessage: (message) => Message.GotTimePickerMessage({ message }),
			}),
			refreshControls(h, model),
			h.div(
				[h.Class("flex items-center gap-1")],
				[
					...(isEdit
						? [
								button(
									h,
									{
										variant: "outline",
										size: "sm",
										isDisabled: isReadOnly,
										attributes: [
											h.Key("add-widget"),
											h.AriaLabel("Add widget"),
											h.OnClick(Message.ClickedAddWidget()),
										],
									},
									[
										icon(h, "PlusIcon", {
											attributes: [h.DataAttribute("icon", "inline-start")],
										}),
										h.span([h.Class("hidden @min-[560px]/page:inline")], ["Add widget"]),
									],
								),
							]
						: []),
					button(
						h,
						{
							variant: isEdit ? "default" : "outline",
							size: "sm",
							isDisabled: isReadOnly,
							attributes: [
								// One element across Edit and Done, so focus survives the toggle.
								h.Key("toggle-edit"),
								h.AriaLabel(isEdit ? "Done editing" : "Edit dashboard"),
								h.OnClick(Message.ClickedToggleEdit()),
							],
						},
						[
							icon(h, isEdit ? "CheckIcon" : "PencilIcon", {
								attributes: [h.DataAttribute("icon", "inline-start")],
							}),
							h.span([h.Class("hidden @min-[560px]/page:inline")], [isEdit ? "Done" : "Edit"]),
						],
					),
					moreMenu(h, model),
				],
			),
		],
	)
}
