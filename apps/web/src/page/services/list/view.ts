import { TONE_COLOR } from "@maple/ui/lib/tone"
import { AsyncData as FoldkitAsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { activeFilterChips } from "../../../ui/filters/active-filter-chips"
import { emptyOnFailure } from "../../../data/enrichment"
import { errorState } from "../../../ui/error-state"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { DEFAULT_PRESET, summaryOf } from "./update"
import { Message } from "./message"
import type { Model, ServiceRow } from "./model"
import { displayedServices } from "./derive"
import { filtersRail } from "./view-filters"
import { loadingState, servicesTable, THROUGHPUT_COLOR } from "./view-table"

/** The colour tokens the sparklines read off the theme. */
const THEME_TOKENS = [TONE_COLOR.crit, THROUGHPUT_COLOR]

const FACETS = [
	{ label: "Environment", include: "environments", exclude: "excludedEnvironments" },
	{ label: "Namespace", include: "namespaces", exclude: "excludedNamespaces" },
	{ label: "Commit SHA", include: "commitShas", exclude: "excludedCommitShas" },
] as const

type ChipParam = (typeof FACETS)[number]["include" | "exclude"]

/** `serviceFilterChips`: exclusions first; URL namespace chips hide while the org pin is on. */
const filterChips = (model: Model, pinnedNamespace: string | null) => {
	const chipOf = (param: ChipParam, label: string, isNegated: boolean) => {
		const values = model.search[param]
		return values === undefined || values.length === 0
			? []
			: [{ id: param, label, values, isNegated, onRemove: Message.RemovedFilterChip({ param }) }]
	}
	return [
		...FACETS.flatMap((facet) => chipOf(facet.exclude, facet.label, true)),
		...FACETS.flatMap((facet) => chipOf(facet.include, facet.label, false)),
	].filter(
		(chip) => pinnedNamespace === null || (chip.id !== "namespaces" && chip.id !== "excludedNamespaces"),
	)
}

const tableArea = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs): Html => {
	const blocking = FoldkitAsyncData.all([
		model.overview.data,
		model.sparklines.data,
		emptyOnFailure(model.anomalies.data),
		emptyOnFailure(model.incidents),
	])
	return FoldkitAsyncData.matchData(blocking, {
		onEmpty: () => loadingState(h),
		onFailure: (failure) => errorState(h, { failure, onRetry: Message.ClickedReload() }),
		// The table paints once its sparklines can: they need the chart runtime and theme colours.
		onData: ([overview]) =>
			!isPaintReady(model, overview)
				? loadingState(h)
				: servicesTable(
						h,
						{
							model,
							summary: summaryOf(model),
							theme: model.themeColors,
							isNamespacePinned: inputs.context.pinnedNamespace !== null,
							timeZone: inputs.context.timeZone,
						},
						overview,
						FoldkitAsyncData.isRefreshing(blocking),
					),
	})
}

const isPaintReady = (model: Model, overview: ReadonlyArray<ServiceRow>): boolean => {
	const services = displayedServices(overview, summaryOf(model), model.search)
	return services.length === 0 || (model.themeColors !== null && model.chartRuntime._tag !== "Loading")
}

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					title: "Services",
					filters: filtersRail(h, model, summaryOf(model), inputs.context.pinnedNamespace),
					actions: timeControls(h, {
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
									presets: TimeRangePicker.LONG_RANGE_PRESET_VALUES,
								},
							}),
					}),
				},
				[
					activeFilterChips(h, { chips: filterChips(model, inputs.context.pinnedNamespace) }),
					tableArea(h, model, inputs),
				],
			),
		],
	),
)
