import { peekSheet } from "./view-peek"
import { advancedFilterDialog, suggestionList } from "./view-advanced"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { kbd } from "@maple/views/ui/display"
import { activeFilterChips } from "@maple/views/ui/filters/active-filter-chips"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { panel } from "@maple/views/ui/panel"
import { truncatedText } from "@maple/views/ui/truncated-text"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { traceFilterChips } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { filtersRail } from "./view-filters"
import { tracesTable } from "./view-table"
import { typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"

/**
 * `AdvancedFilterDialog`'s trigger.
 */
const advancedFilterButton = (h: HtmlBuilder<Message>, model: Model): Html => {
	const isActive = (model.search.whereClause ?? "").trim().length > 0
	return button(
		h,
		{
			variant: isActive ? "secondary" : "outline",
			size: "sm",
			className: "gap-2",
			attributes: [
				h.DataAttribute("shortcut-focus", "search"),
				h.OnClick(Message.ClickedAdvancedFilter()),
			],
		},
		[
			icon(h, "FilterIcon", { className: isActive ? "text-primary" : "text-muted-foreground" }),
			h.span([], ["Advanced filter"]),
			kbd(h, undefined, ["F"]),
		],
	)
}

const whereClausePanel = (h: HtmlBuilder<Message>, whereClause: string): Html =>
	panel(h, { tone: "muted", className: "mb-4 flex-row items-center justify-between gap-2 px-3 py-2" }, [
		hstack(h, { gap: "2", shrink: true }, [
			icon(h, "FilterIcon", { className: "size-3.5 shrink-0 text-primary" }),
			truncatedText(h, {
				text: whereClause,
				mono: true,
				className: typographyClass({ size: "xs", tone: "foreground" }),
			}),
		]),
		iconButton(
			h,
			{
				label: "Clear filter",
				size: "icon-xs",
				className: typographyClass({
					tone: "muted",
					hoverTone: "foreground",
					className: "shrink-0",
				}),
				attributes: [h.OnClick(Message.ClickedClearWhereClause())],
			},
			[icon(h, "XmarkIcon")],
		),
	])

/** The chip bar: URL namespace chips hide while the org pin is on. */
const chips = (model: Model, pinnedNamespace: string | null) =>
	traceFilterChips(model.search)
		.filter(
			(chip) =>
				pinnedNamespace === null || (chip.id !== "namespaces" && chip.id !== "excludedNamespaces"),
		)
		.map((chip) => ({
			id: chip.id,
			label: chip.label,
			values: chip.values,
			isNegated: chip.negated,
			onRemove: Message.RemovedFilterChip({ id: chip.id }),
		}))

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const whereClause = model.search.whereClause ?? ""
	return dashboardPage(
		h,
		{
			title: "Traces",
			filters: filtersRail(h, model, inputs.context.pinnedNamespace),
			actions: hstack(h, { gap: "2", wrap: true }, [
				advancedFilterButton(h, model),
				timeControls(h, {
					search: model.search,
					defaultPreset: DEFAULT_PRESET,
					window: model.window,
					onReset: Message.ClickedResetTimeRange(),
					onReload: Message.ClickedReload(),
					isReloading: model.isReloading,
					trigger: (label) =>
						h.submodel({
							slotId: "time-range-picker",
							model: model.timePicker,
							view: TimeRangePicker.view,
							toParentMessage: toTimePicker,
							viewInputs: {
								label,
								selectedPreset:
									model.search.timePreset ??
									(model.search.startTime === undefined ? DEFAULT_PRESET : undefined),
								presets: TimeRangePicker.PRESET_VALUES,
							},
						}),
				}),
			]),
		},
		[
			...(whereClause === "" ? [] : [whereClausePanel(h, whereClause)]),
			activeFilterChips(h, {
				chips: chips(model, inputs.context.pinnedNamespace),
				onClearAll: Message.ClickedClearAllChips(),
			}),
			tracesTable(h, model, inputs.context.timeZone, inputs.isMobile === true),
			// `peekEnabled = !isMobile`: a phone opens the trace page, so `?peek=` shows no sheet.
			inputs.isMobile === true ? null : peekSheet(h, model, inputs.context.timeZone),
			advancedFilterDialog(h, model),
			...suggestionList(h, model),
		],
	)
})
