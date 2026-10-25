import { resolveRefreshIntervalSeconds } from "../../../lib/dashboard-controls/search-params"
import { shortId } from "@maple/ui/lib/ids"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { isSameFailure } from "../../../data/load-failure"
import { errorState } from "../../../ui/error-state"
import { activeFilterChips } from "../../../ui/filters/active-filter-chips"
import type * as LogsStream from "../../../ui/logs/logs-stream"
import * as LogsStreamView from "../../../ui/logs/logs-stream-view"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { searchPreset, timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import * as LogDetail from "../detail"
import { liveControls } from "../live-controls"
import { chipId, isInspectingOf, logFilterChips } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET, footerText } from "./update"
import { filtersRail } from "./view-filters"
import { emptyState, isNeverReceived } from "./view-empty"
import { toolbar } from "./view-toolbar"
import { VOLUME_THEME_TOKENS, volumeChart } from "./view-volume"

/** `LoadingState`: forty compact placeholder rows (a shorter row makes the list jump on load). */
const loadingState = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("flex-1 min-h-0 flex flex-col")],
		[
			skeletonList(h, {
				rows: 40,
				className: "min-h-0 flex-1 gap-0 overflow-hidden rounded-md border",
				renderRow: () =>
					h.div(
						[h.Class("flex h-9 shrink-0 items-center gap-2 border-b border-border px-3")],
						[
							skeleton(h, "size-1.5 shrink-0 rounded-full"),
							skeleton(h, "h-3 w-16 shrink-0"),
							skeleton(h, "h-3 w-[72px] shrink-0"),
							skeleton(h, "h-3 flex-1"),
						],
					),
			}),
		],
	)

const toStream = (message: LogsStream.Message) => Message.GotStreamMessage({ message })

/** `LogsTableView` with rows: the toolbar, then the stream, inside one refreshing box. */
const streamArea = (
	h: HtmlBuilder<Message>,
	model: Model,
	inputs: PageViewInputs,
	isWaiting: boolean,
): Html =>
	h.div(
		[
			h.Class(cn("flex min-h-0 flex-1 flex-col", refreshingClass(isWaiting))),
			...(isWaiting ? [h.AriaBusy(true)] : []),
		],
		[
			toolbar(h, model),
			h.submodel({
				slotId: "logs-stream",
				model: model.stream,
				view: LogsStreamView.view,
				toParentMessage: toStream,
				viewInputs: {
					wrap: model.wrap,
					density: model.density,
					pinnedColumns: model.search.columns ?? [],
					searchText: model.search.search,
					timeZone: inputs.context.timeZone,
					isWaiting,
					footerText: footerText(model),
					canFilter: true,
					isBare: true,
					selectedIndex: model.selectedIndex ?? undefined,
				},
			}),
		],
	)

const tableArea = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.firstPage.data, {
		// A workspace that never sent logs gets its setup state without waiting on the stream.
		onEmpty: () => (isNeverReceived(model) ? emptyState(h, model) : loadingState(h)),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load logs", onRetry: Message.ClickedReload() }),
		onData: (page) =>
			page.logs.length === 0
				? emptyState(h, model)
				: streamArea(h, model, inputs, AsyncData.isRefreshing(model.firstPage.data)),
	})

/** The applied filters; URL namespace chips hide while the org-global pin is on. */
const filterChips = (model: Model, pinnedNamespace: string | null) =>
	logFilterChips(model.search)
		.filter(
			(chip) =>
				pinnedNamespace === null ||
				(chip.param !== "namespaces" && chip.param !== "excludedNamespaces"),
		)
		.map((chip) => ({
			id: chipId(chip),
			label: chip.label,
			values: chip.values,
			isNegated: chip.negated,
			onRemove: Message.RemovedFilterChip({ chipId: chipId(chip) }),
			// The chip's tooltip keeps the full id; the trace page abbreviates to the same 8 characters.
			valueLabel: chip.param === "traceId" ? (value: string) => shortId(value, "trace") : undefined,
		}))

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

const headerActions = (h: HtmlBuilder<Message>, model: Model): Html => {
	// A custom range is a fixed window: nothing new to tail, so the cadence hides (the URL keeps it).
	const isCustomRange = searchPreset(model.search, DEFAULT_PRESET) === undefined
	return timeControls(h, {
		search: model.search,
		defaultPreset: DEFAULT_PRESET,
		window: model.window,
		onReset: Message.ClickedResetTimeRange(),
		onReload: Message.ClickedReload(),
		isReloading: model.isReloading,
		reloadControls: isCustomRange
			? undefined
			: liveControls(h, {
					refreshInterval: resolveRefreshIntervalSeconds(model.search.refresh, undefined),
					isInspecting: isInspectingOf(model),
					isScrolledAway: model.isScrolledAway,
					isReloading: model.isReloading,
					onReload: Message.ClickedReload(),
					onJumpToLatest: Message.ClickedJumpToLatest(),
					menu: model.refreshMenu,
					toMenuMessage: (message) => Message.GotRefreshMenuMessage({ message }),
				}),
		trigger: (label) =>
			h.submodel({
				slotId: "time-range-picker",
				model: model.timePicker,
				view: TimeRangePicker.view,
				toParentMessage: toTimePicker,
				viewInputs: {
					label,
					selectedPreset: searchPreset(model.search, DEFAULT_PRESET),
					presets: TimeRangePicker.PRESET_VALUES,
				},
			}),
	})
}

const isSharedFailure = (model: Model): boolean => {
	const list = AsyncData.getError(model.firstPage.data)
	const volume = AsyncData.getError(model.volume.data)
	return Option.isSome(list) && Option.isSome(volume) && isSameFailure(list.value, volume.value)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: VOLUME_THEME_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					title: "Logs",
					filters: filtersRail(h, model, inputs.context.pinnedNamespace),
					actions: headerActions(h, model),
					// The list's error panel already explains a shared failure; the chart drops its banner.
					sticky: isSharedFailure(model)
						? undefined
						: volumeChart(h, model, inputs.context.timeZone),
					fill: true,
					isScrolled: model.isScrolledAway,
				},
				[
					h.div(
						[h.Class("flex min-h-0 flex-1 flex-col p-4")],
						[
							activeFilterChips(h, {
								chips: filterChips(model, inputs.context.pinnedNamespace),
								onClearAll: Message.ClickedClearFilterChips(),
							}),
							tableArea(h, model, inputs),
						],
					),
				],
			),
			h.submodel({
				slotId: "logs-detail",
				model: model.detail,
				view: LogDetail.view,
				viewInputs: { timeZone: inputs.context.timeZone },
				toParentMessage: (message) => Message.GotDetailMessage({ message }),
			}),
		],
	),
)
