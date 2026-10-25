import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import { isChartRuntimeReady } from "../../charts/chart-runtime"
import { ResolveThemeColors } from "../../charts/theme-colors"
import { FAILURE_KEY_SEPARATOR, failureKey, isSameFailure, type LoadFailure } from "../../data/load-failure"
import { errorState } from "../../ui/error-state"
import * as Select from "../../ui/select"
import * as SelectView from "../../ui/select-view"
import type { PageViewInputs } from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import { signalEmptyState } from "../kit/signal-empty-state"
import { presenceOf } from "../kit/signal-presence"
import { timeControls } from "../kit/time-controls"
import * as TimeRangePicker from "../kit/time-range-picker"
import {
	defaultPreset,
	environmentFilter,
	environmentItems,
	selectedEnvironment,
	timePresetOf,
} from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { healthList, healthOverview, type SliceSearch } from "./view-health"
import { metricsGrid, THEME_TOKENS } from "./view-metrics"
import { usageCards } from "./view-usage"

import { Message as SetupMessage } from "./setup-checklist"
import * as SetupChecklistView from "./setup-checklist-view"

const EMPTY_COLORS = {}

type H = HtmlBuilder<Message>

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })
const toSelect = (message: Select.Message) => Message.GotEnvironmentSelectMessage({ message })

/** The header: the environment `Select`, then `TimeRangeHeaderControls`, in one row. */
const headerActions = (h: H, model: Model): Html => {
	const preset = defaultPreset(model)
	const controls = timeControls(h, {
		search: model.search,
		defaultPreset: preset,
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
						(model.search.startTime === undefined ? preset : undefined),
					presets: TimeRangePicker.PRESET_VALUES,
				},
			}),
	})
	return h.submodel({
		slotId: "environment-select",
		// The value follows the URL and facets (`selectedEnvironment`), not the trigger's last pick.
		model: { ...model.environmentSelect, value: selectedEnvironment(model) },
		view: SelectView.view,
		toParentMessage: toSelect,
		viewInputs: {
			entries: environmentItems(model).map((item): SelectView.SelectEntry => ({ _tag: "Item", item })),
			size: "sm",
			toView: (parts) => h.div([h.Class("flex items-center gap-2")], [...parts, controls]),
		},
	})
}

/** `ServiceHealthList`'s empty state; skeleton until the page-init presence read settles. */
const servicesEmptyState = (h: H, model: Model): Html =>
	signalEmptyState(h, {
		signal: "traces",
		noun: "services",
		guideDocs: "services",
		presence: presenceOf(model.presence, "traces"),
		nowMs: model.nowMs ?? 0,
		className: "py-8",
	})

type PageFailure = Readonly<{ failure: LoadFailure; title: string; onRetry: Message }>

/** The page-level reads that failed; one strip when both failed the same way. */
const pageFailures = (model: Model): ReadonlyArray<PageFailure> => {
	const facets = Option.getOrUndefined(AsyncData.getError(model.facets.data))
	const setup = model.setup === null ? undefined : SetupChecklistView.setupFailure(model.setup)
	// The strip stands for every quiet card under it, so its Try again retries all failed reads.
	const stripRetry = Message.ClickedRetryPage()
	if (facets !== undefined && setup !== undefined && isSameFailure(facets, setup))
		return [{ failure: facets, title: facets.title, onRetry: stripRetry }]
	return [
		...(facets === undefined ? [] : [{ failure: facets, title: "Couldn't load environments", onRetry: stripRetry }]),
		...(setup === undefined
			? []
			: [
					{
						failure: setup,
						title: "Couldn't check whether your app is sending data",
						onRetry: Message.GotSetupMessage({ message: SetupMessage.TickedPoll() }),
					},
				]),
	]
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const slice: SliceSearch = {
		startTime: model.window?.startTime,
		endTime: model.window?.endTime,
		timePreset: timePresetOf(model),
		environments: environmentFilter(model),
	}
	const nowMs = model.nowMs ?? 0
	const environments = environmentFilter(model)
	const failures = pageFailures(model)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			dashboardPage(h, { title: "Overview", actions: headerActions(h, model) }, [
				...(model.setup === null
					? []
					: [
							h.submodel({
								slotId: "setup-checklist",
								model: model.setup,
								view: SetupChecklistView.view,
								toParentMessage: (message) => Message.GotSetupMessage({ message }),
							}),
						]),
				...failures.map(({ failure, title, onRetry }) =>
					errorState(h, { failure, title, variant: "row", onRetry, className: "mb-4" }),
				),
				healthOverview(h, { model, slice, nowMs }),
				usageCards(h, model, failures.length > 0),
				metricsGrid(h, model, {
					colors: model.themeColors ?? EMPTY_COLORS,
					isChartReady: model.themeColors !== null && isChartRuntimeReady(model.chartRuntime),
					timeZone: inputs.context.timeZone,
					nowMs,
					useRefinement: environments === undefined,
					pageFailureKeys: failures.map(({ failure }) => failureKey(failure)).join(FAILURE_KEY_SEPARATOR),
				}),
				healthList(h, {
					model,
					slice,
					nowMs,
					emptyState: servicesEmptyState(h, model),
					isNeverReceived: presenceOf(model.presence, "traces").status === "absent",
				}),
			]),
		],
	)
})
