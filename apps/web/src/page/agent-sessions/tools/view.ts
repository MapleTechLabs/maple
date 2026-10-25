import { toEpochMs } from "@maple/ui/lib/time-format"
import {
	fillSeriesBuckets,
	metricSpark,
	rankSeriesKeys,
	scopeSummary,
	toolSeriesColors,
} from "@maple/web-data/lib/tool-analytics"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors, resolveColor } from "../../../charts/theme-colors"
import type { LoadFailure } from "../../../data/load-failure"
import { errorState } from "../../../ui/error-state"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { signalEmptyState } from "../../kit/signal-empty-state"
import { presenceOf } from "../../kit/signal-presence"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { agentSessionsTabs } from "../kit/tabs"
import { metricStrip, metricStripLoading } from "../tools-kit/metric-strip"
import {
	DEFAULT_TOOL_PRESET,
	selectedMetric,
	selectedPercentile,
	type ToolSeriesPoint,
} from "../tools-kit/model"
import { scopeRow } from "../tools-kit/scope-row"
import { seriesChart, TOOL_CHART_TOKENS } from "../tools-kit/series-chart"
import { facetSelect, toolFilterToolbar } from "../tools-kit/toolbar"
import { Message } from "./message"
import type { Model } from "./model"
import { bucketSecondsOf } from "./update"
import { toolsTable } from "./view-table"

type H = HtmlBuilder<Message>

const failureOf = <A>(data: AsyncData.AsyncData<A, LoadFailure>): LoadFailure | undefined =>
	Option.getOrUndefined(AsyncData.getError(data))

/** The tab strip's counts: the bare window's sessions and tools (the page's own reads when unfiltered). */
const tabCounts = (model: Model) => ({
	sessions: Option.getOrUndefined(
		Option.map(AsyncData.getData(model.tabTotals.data), (totals) => totals.allSessions),
	),
	tools: Option.getOrUndefined(
		Option.map(AsyncData.getData(model.tabBreakdowns.data), (value) => value.tools.length),
	),
})

/** The per-tool sparks and swatches, from the split series while it splits by tool. */
const toolLanes = (
	series: ReadonlyArray<ToolSeriesPoint>,
	isModels: boolean,
	percentile: Parameters<typeof metricSpark>[2],
) => {
	const keys = [...new Set(series.map((point) => point.seriesKey))]
	const sparks = new Map(
		isModels
			? []
			: keys.map(
					(key) =>
						[
							key,
							metricSpark(
								series.filter((point) => point.seriesKey === key),
								"calls",
								percentile,
							),
						] as const,
				),
	)
	const colors = isModels ? new Map<string, string>() : toolSeriesColors(rankSeriesKeys(series))
	return { sparks, colors }
}

const toolbar = (h: H, model: Model, actions: Html): Html => {
	const facets = Option.getOrUndefined(AsyncData.getData(model.facets.data))
	const select = (
		facet: "service" | "model" | "env",
		options: ReadonlyArray<{ name: string; count: number }>,
	) =>
		facetSelect(h, {
			label: facet,
			value: model.search[facet],
			options,
			model:
				facet === "service"
					? model.serviceSelect
					: facet === "model"
						? model.modelSelect
						: model.envSelect,
			toMessage: (message) => Message.GotFacetSelectMessage({ facet, message }),
		})
	return toolFilterToolbar(h, {
		nameSearch: {
			value: model.searchInput,
			inputId: "agent-tools-search",
			onInput: (value) => Message.ChangedSearchInput({ value }),
			onClear: Message.ChangedSearchInput({ value: "" }),
		},
		selects: [
			select("service", facets?.services ?? []),
			select("model", facets?.models ?? []),
			select("env", facets?.environments ?? []),
		],
		isFailingOnly: model.search.failing === true,
		onToggleFailingOnly: Message.ToggledFailingOnly(),
		isWaiting: AsyncData.isRefreshing(model.totals.data),
		actions,
	})
}

/** `isFilled`: the route zero-fills the scope series over the window; the lab's fixture is already bucketed. */
type BodyOptions = Readonly<{ timeZone: string; isFilled: boolean }>

const loadedView = (h: H, model: Model, options: BodyOptions, actions: Html): Html => {
	const { timeZone } = options
	const totals = Option.getOrUndefined(AsyncData.getData(model.totals.data))
	const { window, themeColors } = model
	if (totals === undefined || window === null || themeColors === null) return h.empty
	const metric = selectedMetric(model.search)
	const percentile = selectedPercentile(model.search)
	const isWaiting = AsyncData.isRefreshing(model.totals.data)
	const series = AsyncData.getOrElse(model.series.data, () => ({ data: [], seriesKind: "tool" as const }))
	const scopeSeries = Option.match(AsyncData.getData(model.scopeSeries.data), {
		onNone: (): ReadonlyArray<ToolSeriesPoint> => [],
		onSome: (value) =>
			options.isFilled
				? fillSeriesBuckets(
						value.data,
						toEpochMs(window.startTime),
						toEpochMs(window.endTime),
						bucketSecondsOf(window),
					)
				: value.data,
	})
	const rows = AsyncData.getOrElse(model.breakdowns.data, () => ({ tools: [] })).tools
	const lanes = toolLanes(series.data, series.seriesKind === "model", percentile)
	const tabs = tabCounts(model)
	return h.div(
		[h.Class("flex flex-col")],
		[
			toolbar(h, model, actions),
			...(tabs.tools === 0
				? [
						h.div(
							[h.Class("contents")],
							[
								signalEmptyState(h, {
									signal: "traces",
									presence: presenceOf(model.presence, "traces"),
									nowMs: model.nowMs,
									noun: "agent tool calls",
									purpose:
										"See every tool your AI agents call, with volume, latency and failures.",
									guideDocs: "agentSessions",
									className: "px-6 py-16",
								}),
							],
						),
					]
				: [
						scopeRow(h, {
							chips: [
								...(model.search.tool === undefined
									? []
									: [{ kind: "tool" as const, value: model.search.tool }]),
								...(model.search.model === undefined
									? []
									: [{ kind: "model" as const, value: model.search.model }]),
							],
							summary: scopeSummary(
								totals.current,
								rows.reduce((sum, row) => sum + row.calls, 0),
							),
							onRemove: (chip) => Message.RemovedScopeChip({ kind: chip.kind }),
							onClearAll: Message.ClickedClearScope(),
						}),
						metricStrip(h, {
							totals: totals.current,
							previous: totals.previous,
							series: scopeSeries,
							metric,
							percentile,
							allSessions: totals.allSessions,
							windowLabel: model.search.timePreset ?? DEFAULT_TOOL_PRESET,
							onSelectMetric: (next) => Message.ClickedMetric({ metric: next }),
							percentileToggle: model.percentileToggle,
							toPercentileMessage: (message) => Message.GotPercentileMessage({ message }),
						}),
						seriesChart(
							h,
							{
								chartId: "agent-tools-scope-chart",
								series: scopeSeries,
								metric,
								percentile,
								tool: model.search.tool,
								model: model.search.model,
								isLoading:
									!AsyncData.hasData(model.scopeSeries.data) &&
									failureOf(model.scopeSeries.data) === undefined,
								failure: failureOf(model.scopeSeries.data),
								isWaiting,
								theme: themeColors,
								timeZone,
							},
							model.chart,
							(message) => Message.GotChartMessage({ message }),
						),
						toolsTable(h, {
							rows,
							percentile,
							search: model.search,
							sort: model.tableSort,
							sparkFor: (tool) => lanes.sparks.get(tool) ?? [],
							colorFor: (tool) => lanes.colors.get(tool),
							sparkColor: resolveColor(themeColors, "--primary"),
							isLoading:
								!AsyncData.hasData(model.breakdowns.data) &&
								failureOf(model.breakdowns.data) === undefined,
							failure: failureOf(model.breakdowns.data),
							isWaiting,
							nowMs: model.nowMs,
							timeZone,
						}),
					]),
		],
	)
}

const loadingView = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-5 pt-3")],
		[
			skeleton(h, "mx-6 h-8 max-w-2xl"),
			metricStripLoading(h),
			skeleton(h, "mx-6 h-56"),
			skeleton(h, "mx-6 h-80"),
		],
	)

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

const timeActions = (h: H, model: Model): Html =>
	timeControls(h, {
		search: model.search,
		defaultPreset: DEFAULT_TOOL_PRESET,
		window: model.window,
		onReset: Message.ClickedResetTimeRange(),
		onReload: Message.ClickedReload(),
		isReloading: model.isReloading,
		trigger: (label) =>
			h.submodel({
				slotId: "agent-tools-time-range-picker",
				model: model.timePicker,
				view: TimeRangePicker.view,
				toParentMessage: toTimePicker,
				viewInputs: {
					label,
					selectedPreset:
						model.search.timePreset ??
						(model.search.startTime === undefined ? DEFAULT_TOOL_PRESET : undefined),
					presets: TimeRangePicker.PRESET_VALUES,
				},
			}),
	})

/** `AgentToolsBody`: the toolbar, scope, strip, chart and table, or their loading and error states. */
export const toolsBody = (h: H, model: Model, options: BodyOptions): Html =>
	AsyncData.matchData(model.totals.data, {
		onEmpty: () => loadingView(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load agent tool analytics",
				onRetry: Message.ClickedReload(),
			}),
		onData: () =>
			model.themeColors === null || model.chartRuntime._tag === "Loading"
				? loadingView(h)
				: loadedView(h, model, options, timeActions(h, model)),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: TOOL_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					title: "Agent Sessions",
					tabs: agentSessionsTabs(h, {
						active: "tools",
						search: model.search,
						counts: tabCounts(model),
						className: "border-b border-border",
					}),
					scrollClassName: "p-0",
				},
				[toolsBody(h, model, { timeZone: inputs.context.timeZone, isFilled: true })],
			),
		],
	),
)
