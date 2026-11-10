import { peekSheet } from "./view-peek"
import { advancedFilterDialog, suggestionList } from "./view-advanced"
import { Submodel } from "foldkit"
import { activeFilterChips } from "@maple/views/ui/filters/active-filter-chips"
import type { PageViewInputs } from "../../contract"
import { advancedFilterButton, appliedWhereClause } from "../../kit/advanced-filter"
import { dashboardPage } from "../../kit/dashboard-page"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { traceFilterChips } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { filtersRail } from "./view-filters"
import { tracesTable } from "./view-table"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"

/** The chip bar: URL namespace chips hide while the org pin is on. */
const chips = (model: Model, pinnedNamespace: string | null) =>
	Arr.map(
		Arr.filter(
			traceFilterChips(model.search),
			(chip) =>
				pinnedNamespace === null || (chip.id !== "namespaces" && chip.id !== "excludedNamespaces"),
		),
		(chip) => ({
			id: chip.id,
			label: chip.label,
			values: chip.values,
			isNegated: chip.negated,
			operator: chip.operator,
			onRemove: Message.RemovedFilterChip({ id: chip.id }),
		}),
	)

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const whereClause = Str.trim(model.search.whereClause ?? "")
	return dashboardPage(
		h,
		{
			title: "Traces",
			filters: filtersRail(h, model, inputs.context.pinnedNamespace),
			actions: hstack(h, { gap: "2", wrap: true }, [
				advancedFilterButton(h, {
					isActive: whereClause !== "",
					onClick: Message.ClickedAdvancedFilter(),
					attributes: [h.DataAttribute("shortcut-focus", "search")],
				}),
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
			...(whereClause === ""
				? []
				: [appliedWhereClause(h, { whereClause, onClear: Message.ClickedClearWhereClause() })]),
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
