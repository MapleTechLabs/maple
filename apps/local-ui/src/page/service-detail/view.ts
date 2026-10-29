import { WIDEST_RANGE } from "../../lib/time"
import * as AreaChart from "@maple/web/charts/area-chart"
import { isChartRuntimeReady } from "@maple/web/charts/chart-runtime"
import { ResolveThemeColors } from "@maple/web/charts/theme-colors"
import { button } from "@maple/web/ui/button"
import { spinner } from "@maple/web/ui/spinner"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { type PageContext, rangeOf } from "../contract"
import { seriesChart, seriesChartSlotId } from "../kit/series-chart"
import { emptyState, errorState } from "../kit/view-states"
import { boundsOf, chartOf, topSpanNames } from "./load"
import {
	OperationsChartBinding,
	ServiceDetailComposition,
	type ServiceDetailViewBuilder,
} from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { GOLDEN_TOKENS, goldenSignals } from "./view-golden"
import { topOperations } from "./view-operations"
import { detailHeader, statCards } from "./view-parts"

// The service detail page: one service's golden signals, operations and recent traces.

/** What the view reads from the root: data only, as Block view inputs carry no callbacks. */
export type ServiceDetailViewInputs = Readonly<{
	context: PageContext
	/** The server's last ingest, for `useNewDataSince`'s "New data" pill. */
	lastIngestAtMs: Option.Option<number>
}>

/** `useNewDataSince(sinceMs)`: telemetry arrived after the overview loaded. */
const hasNewDataSince = (inputs: ServiceDetailViewInputs, sinceMs: number): boolean =>
	sinceMs > 0 && Option.exists(inputs.lastIngestAtMs, (last) => last > sinceMs)

const THEME_TOKENS = [...GOLDEN_TOKENS, ...AreaChart.AREA_CHART_TOKENS]

const quiet = (h: ServiceDetailViewBuilder, range: string): Html =>
	h.div(
		[h.Class("flex h-full flex-col items-center justify-center gap-3")],
		[
			emptyState(h, {
				title: "No spans from this service in this range",
				hint: ["Widen the time range, or send some traffic to this service."],
			}),
			...(range !== WIDEST_RANGE
				? [
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								attributes: [h.OnClick(Message.ClickedWidenRange())],
							},
							["Widen to 30 days"],
						),
					]
				: []),
		],
	)

const loaded = (
	h: ServiceDetailViewBuilder,
	model: Model,
	inputs: ServiceDetailViewInputs,
	stats: Parameters<typeof statCards>[1],
): Html => {
	const range = rangeOf(inputs.context)
	const bounds = Option.getOrNull(boundsOf(model, inputs.context))
	const context =
		model.themeColors !== null && isChartRuntimeReady(model.chartRuntime)
			? { theme: model.themeColors, nowMs: model.nowMs }
			: null
	const goldenFailure = failureWithoutData(model.golden)
	const charts =
		bounds === null
			? []
			: [
					Option.isSome(goldenFailure)
						? errorState(h, {
								label: "service charts",
								failure: goldenFailure.value,
								onRetry: Message.ClickedRetryGoldenSignals(),
							})
						: goldenSignals(
								h,
								model,
								Option.getOrElse(AsyncData.getData(model.golden.data), () => []),
								chartOf(model, bounds),
								isPending(model.golden),
								context,
							),
					h.section(
						[h.Class("space-y-2")],
						[
							h.h3([h.Class("text-sm font-medium")], ["Throughput by operation"]),
							seriesChart(h, {
								chartId: "operations-throughput",
								points: Option.getOrElse(AsyncData.getData(model.timeseries.data), () => []),
								window: chartOf(model, bounds),
								fill: "zero",
								unit: "requests_per_sec",
								isPending: isPending(model.timeseries) && topSpanNames(model).length > 0,
								renderChart: (viewInputs) =>
									h.block(
										OperationsChartBinding.embedView({
											slotId: seriesChartSlotId("operations-throughput"),
											model: model.operationsChart,
											view: AreaChart.view,
											viewInputs,
										}),
									),
								theme: context === null ? null : context.theme,
								nowMs: model.nowMs,
							}),
						],
					),
				]
	return h.div([h.Class("space-y-6 p-4")], [statCards(h, stats), ...charts, topOperations(h, model, range)])
}

const content = (h: ServiceDetailViewBuilder, model: Model, inputs: ServiceDetailViewInputs): Html => {
	if (isPending(model.overview))
		return h.div([h.Class("flex h-full items-center justify-center")], [spinner(h)])
	const failure = failureWithoutData(model.overview)
	if (Option.isSome(failure))
		return errorState(h, {
			label: "service",
			failure: failure.value,
			onRetry: Message.ClickedRetryOverview(),
		})
	const overview = Option.getOrNull(AsyncData.getData(model.overview.data))
	return overview === null ? quiet(h, rangeOf(inputs.context)) : loaded(h, model, inputs, overview.stats)
}

export const view = ServiceDetailComposition.makeView.withInputs<ServiceDetailViewInputs>(
	(model, inputs, h) => {
		const overview = Option.getOrNull(AsyncData.getData(model.overview.data))
		return h.div(
			[h.Class("flex h-full flex-col"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
			[
				detailHeader(h, {
					serviceName: model.serviceName,
					backLabel: inputs.context.canGoBack ? "Back" : "Services",
					environments: overview?.stats.deploymentEnvironments ?? [],
					range: rangeOf(inputs.context),
					isRefreshing: model.isRefreshing,
					hasNewData: hasNewDataSince(inputs, model.overviewUpdatedAtMs),
				}),
				h.div([h.Class("min-h-0 flex-1 overflow-auto")], [content(h, model, inputs)]),
			],
		)
	},
)
