import { isChartRuntimeReady } from "@maple/web/charts/chart-runtime"
import { ResolveThemeColors } from "@maple/web/charts/theme-colors"
import { METRIC_TYPE_COLORS } from "@maple/web/page/metrics/shared"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { queryOf } from "../../route"
import { rangeOf } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { pageShell } from "../kit/page-shell"
import { signalEmptyState } from "../kit/signal-empty-state"
import {
	refreshButton,
	timeRangeSelect,
	toolbar,
	toolbarSearch,
	toolbarStat,
	toolbarStats,
} from "../kit/toolbar"
import { errorState, listSkeleton } from "../kit/view-states"
import { metricsFilters } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { visibleEntries } from "./update"
import { metricGrid } from "./view-grid"
import { sidebar } from "./view-sidebar"

// The Metrics page: the metric catalog as a grid, with filters.

/** The colours the sparklines resolve: the type palette and the fallback. */
const THEME_TOKENS = [...METRIC_TYPE_COLORS.values(), "var(--chart-1)"]

const toCopy = (id: string, message: Parameters<typeof Message.GotCopyMessage>[0]["message"]) =>
	Message.GotCopyMessage({ id, message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const { context } = inputs
	const { service, type, search } = metricsFilters(context)
	const range = rangeOf(context)
	const entries = visibleEntries(model, service)
	const activeFilterCount = [service, type].filter(Boolean).length
	const totalDataPoints = Option.getOrElse(AsyncData.getData(model.summary.data), () => []).reduce(
		(sum, row) => sum + row.dataPointCount,
		0,
	)
	const content = (): Html => {
		if (isPending(model.list)) return listSkeleton(h, { variant: "grid", rows: 9 })
		const failure = failureWithoutData(model.list)
		if (Option.isSome(failure))
			return errorState(h, {
				label: "metrics",
				failure: failure.value,
				onRetry: Message.ClickedRefresh(),
			})
		if (entries.length === 0)
			return signalEmptyState(h, {
				signal: "metrics",
				isFiltered: activeFilterCount > 0 || search !== undefined,
				onClearFilters: Message.ClickedClearFilters(),
				range,
				onWidenRange: Message.ClickedWidenRange(),
				maybePresence: inputs.presenceOf("metrics"),
				nowMs: inputs.presenceNowMs,
				guide: {
					id: "metrics-empty",
					endpoint: context.env.otlpEndpoint,
					copies: model.copies,
					toCopyMessage: toCopy,
				},
			})
		const theme = model.themeColors
		if (theme === null || !isChartRuntimeReady(model.chartRuntime))
			return listSkeleton(h, { variant: "grid", rows: 9 })
		const sparklines = AsyncData.getData(model.sparklines.data)
		return metricGrid(h, {
			entries,
			points: Option.getOrUndefined(
				Option.map(
					sparklines,
					(list) => new Map(list.map((entry) => [entry.metricName, entry.points])),
				),
			),
			isLoading: isPending(model.sparklines),
			isFailed: Option.isSome(failureWithoutData(model.sparklines)),
			query: queryOf(context.location),
			isDimmed: model.list.isPlaceholder,
			viewport: model.grid,
			theme,
		})
	}
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			pageShell(
				h,
				{
					onOpenFilters: Message.ClickedOpenFilters(),
					sidebar: sidebar(h, model, { service, type }, activeFilterCount),
					toolbar: toolbar(h, [
						toolbarSearch(h, {
							id: "metrics-search",
							value: model.search.text,
							placeholder: "Filter by metric name…",
							onInput: (text) => Message.ChangedSearch({ text }),
							onClear: Message.ClickedClearSearch(),
							className: "min-w-48 flex-1",
						}),
						toolbarStats(
							h,
							[
								toolbarStat(h, { value: entries.length, label: "metrics" }),
								toolbarStat(h, { value: totalDataPoints, label: "datapoints" }),
								refreshButton(h, {
									isSpinning: model.isRefreshing,
									hasNewData: inputs.hasNewDataSince(model.listUpdatedAtMs),
									onRefresh: Message.ClickedRefresh(),
								}),
								timeRangeSelect(h, range, (next) => Message.ChangedRange({ range: next })),
							],
							"shrink-0",
						),
					]),
					activeFilterCount,
				},
				[content()],
			),
		],
	)
})
