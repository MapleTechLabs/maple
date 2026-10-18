import {
	REFRESH_INTERVAL_OPTIONS,
	resolveRefreshIntervalSeconds,
} from "@maple/web/lib/dashboard-controls/search-params"
import { cn } from "@maple/ui/lib/utils"
import { rowActionsMenuContentStyles, rowActionsMenuIconStyles } from "@maple/ui/styles/ui/row-actions-menu"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import * as MenuView from "../../../ui/menu-view"
import { refreshButton } from "../../../ui/refresh-button"
import { presetLabel } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { Message } from "./message"
import type { Model } from "./model"
import { isEditing } from "./update"

// `DashboardToolbar` (dashboard-builder/toolbar/dashboard-toolbar.tsx) and `RefreshControls`
// (components/time-range-picker/refresh-controls.tsx).
// TODO(variables): `VariableSelects` renders its empty strip only; boards with variables lack it.

type H = HtmlBuilder<Message>

/** `formatRefreshInterval`: `0` is off. */
const formatInterval = (seconds: number): string =>
	seconds === 0 ? "Off" : seconds < 60 ? `${seconds}s` : `${seconds / 60}m`

const refreshControls = (h: H, model: Model): Html => {
	const seconds = resolveRefreshIntervalSeconds(
		model.search.refresh,
		model.document?.refreshIntervalSeconds,
	)
	const isOn = seconds > 0
	return h.div(
		[h.Class("flex items-center")],
		[
			refreshButton(h, {
				onRefresh: Message.ClickedReload(),
				isPending: model.isReloading,
				label: "Reload",
				className: "relative rounded-r-none before:rounded-r-none focus-visible:z-10",
			}),
			h.submodel({
				slotId: model.refreshMenu.id,
				model: model.refreshMenu,
				view: MenuView.view,
				viewInputs: {
					entries: [
						{
							_tag: "RadioGroup",
							label: "Auto-refresh",
							isLabelWrapped: true,
							items: REFRESH_INTERVAL_OPTIONS.map((option) => ({
								value: String(option),
								label: formatInterval(option),
								isChecked: option === seconds,
								...(model.document?.refreshIntervalSeconds === option
									? { hint: "default" }
									: undefined),
							})),
						},
					],
					align: "end",
					className: "min-w-40",
					toView: ({ trigger, withTrigger }) =>
						h.div(
							[h.Class("contents")],
							withTrigger(
								button(
									h,
									{
										variant: "outline",
										size: "sm",
										className:
											"relative -ml-px rounded-l-none before:rounded-l-none focus-visible:z-10",
										attributes: [
											h.Title(
												isOn
													? `Reloading every ${formatInterval(seconds)}`
													: "Auto-refresh is off",
											),
											h.AriaLabel(
												isOn
													? `Auto-refresh every ${formatInterval(seconds)}`
													: "Auto-refresh off",
											),
											...trigger,
										],
									},
									[
										h.span(
											[h.Class(cn("tabular-nums", !isOn && "text-muted-foreground"))],
											[formatInterval(seconds)],
										),
										icon(h, "ChevronDownIcon", { className: "size-3 opacity-60" }),
									],
								),
							),
						),
				},
				toParentMessage: (message) => Message.GotRefreshMenuMessage({ message }),
			}),
		],
	)
}

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

/** `RowActionsMenu label="More dashboard actions"`. TODO(toolbar): only Export acts; the rest are inert. */
const moreMenu = (h: H, model: Model): Html =>
	h.submodel({
		slotId: model.moreMenu.id,
		model: model.moreMenu,
		view: MenuView.view,
		viewInputs: {
			entries: moreEntries(isEditing(model)),
			align: "end",
			className: rowActionsMenuContentStyles,
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								variant: "ghost",
								size: "icon-sm",
								attributes: [
									h.AriaLabel("More dashboard actions"),
									...trigger,
									h.DataAttribute("slot", "row-actions-trigger"),
								],
							},
							[icon(h, "DotsVerticalIcon", { className: rowActionsMenuIconStyles })],
						),
					),
				),
		},
		toParentMessage: (message) => Message.GotMoreMenuMessage({ message }),
	})

/**
 * `VariableSelects` in edit mode on a board without variables: the "+ Variable" chip.
 * TODO(variables): it opens `VariablesManagerDialog`, which is not ported; the chip is inert.
 */
const variableManageChip = (h: H): Html =>
	h.div(
		[h.Class("flex items-center gap-1.5")],
		[
			button(
				h,
				{
					variant: "ghost",
					size: "sm",
					className: "text-muted-foreground",
					attributes: [h.AriaLabel("Add dashboard variable")],
				},
				[icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }), "Variable"],
			),
		],
	)

const timeLabel = (model: Model): string =>
	model.timeRange === null
		? ""
		: model.timeRange.type === "relative"
			? presetLabel(model.timeRange.value)
			: `${model.timeRange.startTime} - ${model.timeRange.endTime}`

export const toolbar = (h: H, model: Model, timeZone: string): Html => {
	const isEdit = isEditing(model)
	const isReadOnly = model.persistenceError !== null
	return h.div(
		[h.Class("flex flex-wrap items-center justify-end gap-2 @min-[720px]/page:gap-3")],
		[
			h.div(
				[h.Class("flex min-w-0 max-w-full items-center overflow-x-auto")],
				isEdit && !isReadOnly ? [variableManageChip(h)] : [],
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
										h.span([h.Class("hidden @min-[560px]/page:inline")], ["Add Widget"]),
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
								// One element across Edit and Done, as React keeps it, so focus survives the toggle.
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
