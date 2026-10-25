import { WIDEST_RANGE } from "../../lib/time"
import * as Chart from "@maple/web/charts/chart"
import { AREA_CHART_TOKENS } from "@maple/web/charts/area-chart"
import { isChartRuntimeReady } from "@maple/web/charts/chart-runtime"
import { ResolveThemeColors } from "@maple/web/charts/theme-colors"
import { button } from "@maple/web/ui/button"
import { spinner } from "@maple/web/ui/spinner"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { rangeOf } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { seriesChart } from "../kit/series-chart"
import { emptyState, errorState } from "../kit/view-states"
import { boundsOf, chartOf, topSpanNames } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { GOLDEN_TOKENS, goldenSignals } from "./view-golden"
import { topOperations } from "./view-operations"
import { detailHeader, statCards } from "./view-parts"

// The service detail page: one service's golden signals, operations and recent traces.

const THEME_TOKENS = [...GOLDEN_TOKENS, ...AREA_CHART_TOKENS]

const quiet = (h: HtmlBuilder<Message>, range: string): Html =>
	h.div(
		[h.Class("flex h-full flex-col items-center justify-center gap-3")],
		[
			emptyState(h, {
				title: "No spans from this service in this range",
				hint: ["Widen the time range, or send some traffic to this service."],
			}),
			...(range !== WIDEST_RANGE
				? [button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedWidenRange())] }, ["Widen to 30 days"])]
				: []),
		],
	)

const loaded = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs, stats: Parameters<typeof statCards>[1]): Html => {
	const range = rangeOf(inputs.context)
	const bounds = Option.getOrNull(boundsOf(model, inputs.context))
	const context =
		model.themeColors !== null && isChartRuntimeReady(model.chartRuntime) ? { theme: model.themeColors, nowMs: model.nowMs } : null
	const goldenFailure = failureWithoutData(model.golden)
	const charts =
		bounds === null
			? []
			: [
					Option.isSome(goldenFailure)
						? errorState(h, { label: "service charts", failure: goldenFailure.value, onRetry: Message.ClickedRetryGoldenSignals() })
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
								chart: model.charts["operations-throughput"] ?? Chart.init(),
								toChartMessage: (message) => Message.GotChartMessage({ chartId: "operations-throughput", message }),
								theme: context === null ? null : context.theme,
								nowMs: model.nowMs,
							}),
						],
					),
				]
	return h.div([h.Class("space-y-6 p-4")], [statCards(h, stats), ...charts, topOperations(h, model, range)])
}

const content = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs): Html => {
	if (isPending(model.overview)) return h.div([h.Class("flex h-full items-center justify-center")], [spinner(h)])
	const failure = failureWithoutData(model.overview)
	if (Option.isSome(failure))
		return errorState(h, { label: "service", failure: failure.value, onRetry: Message.ClickedRetryOverview() })
	const overview = Option.getOrNull(AsyncData.getData(model.overview.data))
	return overview === null ? quiet(h, rangeOf(inputs.context)) : loaded(h, model, inputs, overview.stats)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
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
				hasNewData: inputs.hasNewDataSince(model.overviewUpdatedAtMs),
			}),
			h.div([h.Class("min-h-0 flex-1 overflow-auto")], [content(h, model, inputs)]),
		],
	)
})
