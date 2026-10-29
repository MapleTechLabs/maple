import { isChartRuntimeReady } from "@maple/web/charts/chart-runtime"
import { ResolveThemeColors } from "@maple/web/charts/theme-colors"
import { METRIC_TYPE_COLORS } from "@maple/web/page/metrics/shared"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { queryOf } from "../../route"
import { rangeOf } from "../contract"
import { MetricsComposition } from "./composition"
import { type PresenceResult, presenceOf } from "../../data/signal-presence"
import type { PageContext } from "../contract"
import { pageShell } from "../kit/page-shell"
import { signalEmptyState } from "../kit/signal-empty-state"
import { refreshButton, timeRangeSelect, toolbar, toolbarSearch, toolbarStat, toolbarStats } from "../kit/toolbar"
import { errorState, listSkeleton } from "../kit/view-states"
import { metricsFilters } from "./load"
import { Message } from "./message"
import { visibleEntries } from "./update"
import { metricGrid } from "./view-grid"
import { sidebar } from "./view-sidebar"

// The Metrics page: the metric catalog as a grid, with filters.

/** The colours the sparklines resolve: the type palette and the fallback. */
const THEME_TOKENS = [...METRIC_TYPE_COLORS.values(), "var(--chart-1)"]

/** What the view reads from the root: data only, as Block view inputs carry no callbacks. */
export type MetricsViewInputs = Readonly<{
	context: PageContext
	/** `useSignalPresence`: the shared read, none while unknown (loading or unreadable). */
	presence: Option.Option<PresenceResult>
	/** The server's last ingest, for `useNewDataSince`'s "New data" pill. */
	lastIngestAtMs: Option.Option<number>
}>

/** `useNewDataSince(sinceMs)`: telemetry arrived after the list loaded. */
const hasNewDataSince = (inputs: MetricsViewInputs, sinceMs: number): boolean =>
	sinceMs > 0 && Option.exists(inputs.lastIngestAtMs, (last) => last > sinceMs)

export const view = MetricsComposition.makeView.withInputs<MetricsViewInputs>((model, inputs, h) => {
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
			return errorState(h, { label: "metrics", failure: failure.value, onRetry: Message.ClickedRefresh() })
		if (entries.length === 0)
			return signalEmptyState(h, {
				signal: "metrics",
				isFiltered: activeFilterCount > 0 || search !== undefined,
				onClearFilters: Message.ClickedClearFilters(),
				range,
				onWidenRange: Message.ClickedWidenRange(),
				maybePresence: presenceOf(inputs.presence, "metrics"),
				nowMs: Option.match(inputs.presence, { onNone: () => 0, onSome: (result) => result.nowMs }),
				guide: {
					id: "metrics-empty",
					endpoint: context.env.otlpEndpoint,
					copies: model.copies,
					toCopyMessage: (message) => Message.ReceivedCopyMessage({ message }),
				},
			})
		const theme = model.themeColors
		if (theme === null || !isChartRuntimeReady(model.chartRuntime)) return listSkeleton(h, { variant: "grid", rows: 9 })
		const sparklines = AsyncData.getData(model.sparklines.data)
		return metricGrid(h, {
			entries,
			points: Option.getOrUndefined(
				Option.map(sparklines, (list) => new Map(list.map((entry) => [entry.metricName, entry.points]))),
			),
			isLoading: isPending(model.sparklines),
			isFailed: Option.isSome(failureWithoutData(model.sparklines)),
			query: queryOf(context.location),
			isDimmed: model.list.isPlaceholder,
			viewport: model.grid,
			theme,
			chart: model.sparkline,
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
									hasNewData: hasNewDataSince(inputs, model.listUpdatedAtMs),
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
