import { peekSheet } from "./view-peek"
import { advancedFilterDialog, suggestionList } from "./view-advanced"
import { Submodel } from "foldkit"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { activeFilterChips } from "@maple/views/ui/filters/active-filter-chips"
import type { PageViewInputs } from "../../contract"
import { advancedFilterButton, appliedWhereClause } from "../../kit/advanced-filter"
import { stableSlice } from "../../kit/stable-slice"
import { dashboardPage } from "../../kit/dashboard-page"
import { timeControls } from "../../kit/time-controls"
import * as SavedViews from "../../kit/saved-views"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { traceFilterChips } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { viewsExplorer } from "./saved-views"
import { filtersRail, type RailModel } from "./view-filters"
import { tracesTable } from "./view-table"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str, Struct } from "effect"

/** The chip bar: URL namespace chips hide while the org pin is on. */
const chips = (search: Model["search"], pinnedNamespace: string | null) =>
	Arr.map(
		Arr.filter(
			traceFilterChips(search),
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

type ActionsModel = Pick<Model, "search" | "savedViews" | "window" | "isReloading" | "timePicker">

const actions = (h: HtmlBuilder<Message>, model: ActionsModel): Html => {
	const whereClause = Str.trim(model.search.whereClause ?? "")
	return hstack(h, { gap: "2", wrap: true }, [
		SavedViews.control(h, {
			slotId: "traces-saved-views",
			model: model.savedViews,
			explorer: viewsExplorer([model.search]),
			toMessage: (message) => Message.GotSavedViewsMessage({ message }),
		}),
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
	])
}

const chipBar = (h: HtmlBuilder<Message>, search: Model["search"], pinnedNamespace: string | null): Html =>
	activeFilterChips(h, {
		chips: chips(search, pinnedNamespace),
		onClearAll: Message.ClickedClearAllChips(),
	})

// Scrolling the table, the peek sheet and the advanced editor send messages that change none of
// these, so each keeps its tree instead of rebuilding with the page.
const railSlot = createLazy()
// Below `lg` the shell lifts the rail into a sheet; above it the rail is inline. A cached tree
// shared across that move loses its listeners when snabbdom tears down the old place, so the
// position is a cache argument and each place gets its own tree.
const railAt = (
	h: HtmlBuilder<Message>,
	rail: RailModel,
	pinnedNamespace: string | null,
	_isBelowLg: boolean,
): Html => filtersRail(h, rail, pinnedNamespace)
const railOf = stableSlice((model: Model) =>
	Struct.pick(model, ["search", "facets", "filterSections", "firstPage", "durationDraft"]),
)
const actionsSlot = createLazy()
const actionsOf = stableSlice((model: Model) =>
	Struct.pick(model, ["search", "savedViews", "window", "isReloading", "timePicker"]),
)
const chipsSlot = createLazy()

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const whereClause = Str.trim(model.search.whereClause ?? "")
	const pinnedNamespace = inputs.context.pinnedNamespace
	return dashboardPage(
		h,
		{
			title: "Traces",
			width: "full",
			filters: railSlot(railAt, [h, railOf(model), pinnedNamespace, inputs.isBelowLg === true]),
			actions: actionsSlot(actions, [h, actionsOf(model)]),
		},
		[
			...(whereClause === ""
				? []
				: [appliedWhereClause(h, { whereClause, onClear: Message.ClickedClearWhereClause() })]),
			chipsSlot(chipBar, [h, model.search, pinnedNamespace]),
			tracesTable(h, model, inputs.context.timeZone, inputs.isMobile === true),
			// `peekEnabled = !isMobile`: a phone opens the trace page, so `?peek=` shows no sheet.
			inputs.isMobile === true ? null : peekSheet(h, model, inputs.context.timeZone),
			advancedFilterDialog(h, model),
			...suggestionList(h, model),
		],
	)
})
