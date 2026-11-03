import { errorState } from "@maple/views/ui/error-state"
import { WIDEST_RANGE } from "../../lib/time"
import * as Chart from "@maple/views/charts/chart"
import { AREA_CHART_TOKENS } from "@maple/views/charts/area-chart"
import { isChartRuntimeReady } from "@maple/views/charts/chart-runtime"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { button } from "@maple/views/ui/button"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import { heading } from "@maple/views/ui/heading"
import { scrollRegion } from "@maple/views/ui/scroll-region"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isAwaitingFirstData } from "@maple/views/data/keyed"
import { rangeOf } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { emptyNotice } from "../kit/placeholders"
import { seriesChart } from "../kit/series-chart"
import { boundsOf, chartOf, topSpanNames } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { GOLDEN_TOKENS, goldenSignals } from "./view-golden"
import { topOperations } from "./view-operations"
import { detailHeader, statCards } from "./view-parts"
import { vstack } from "@maple/views/ui/stack"
import { loadingFill } from "../kit/page-body"

// The service detail page: one service's golden signals, operations and recent traces.

const THEME_TOKENS = [...GOLDEN_TOKENS, ...AREA_CHART_TOKENS]

const quiet = (h: HtmlBuilder<Message>, range: string): Html =>
	vstack(h, { gap: "3", align: "center", justify: "center", className: "h-full" }, [
		emptyNotice(h, {
			title: "No spans from this service in this range",
			hint: "Widen the time range, or send some traffic to this service.",
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
	])

const loaded = (
	h: HtmlBuilder<Message>,
	model: Model,
	inputs: PageViewInputs,
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
								failure: goldenFailure.value,
								title: "Couldn’t load service charts",
								onRetry: Message.ClickedRetryGoldenSignals(),
							})
						: goldenSignals(
								h,
								model,
								Option.getOrElse(AsyncData.getData(model.golden.data), () => []),
								chartOf(model, bounds),
								isAwaitingFirstData(model.golden),
								context,
							),
					h.section(
						[h.Class("space-y-2")],
						[
							heading(h, { level: 3, variant: "subsection" }, ["Throughput by operation"]),
							seriesChart(h, {
								chartId: "operations-throughput",
								points: Option.getOrElse(AsyncData.getData(model.timeseries.data), () => []),
								window: chartOf(model, bounds),
								fill: "zero",
								unit: "requests_per_sec",
								isPending:
									isAwaitingFirstData(model.timeseries) && topSpanNames(model).length > 0,
								chart: model.charts["operations-throughput"] ?? Chart.init(),
								toChartMessage: (message) =>
									Message.GotChartMessage({ chartId: "operations-throughput", message }),
								theme: context === null ? null : context.theme,
								nowMs: model.nowMs,
							}),
						],
					),
				]
	return h.div([h.Class("space-y-6 p-4")], [statCards(h, stats), ...charts, topOperations(h, model, range)])
}

const content = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs): Html => {
	if (isAwaitingFirstData(model.overview)) return loadingFill(h)
	const failure = failureWithoutData(model.overview)
	if (Option.isSome(failure))
		return errorState(h, {
			failure: failure.value,
			title: "Couldn’t load service",
			onRetry: Message.ClickedRetryOverview(),
		})
	const overview = Option.getOrNull(AsyncData.getData(model.overview.data))
	return overview === null ? quiet(h, rangeOf(inputs.context)) : loaded(h, model, inputs, overview.stats)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const overview = Option.getOrNull(AsyncData.getData(model.overview.data))
	return vstack(
		h,
		{ className: "h-full", attributes: [h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))] },
		[
			detailHeader(h, {
				serviceName: model.serviceName,
				backLabel: inputs.context.canGoBack ? "Back" : "Services",
				environments: overview?.stats.deploymentEnvironments ?? [],
				range: rangeOf(inputs.context),
				isRefreshing: model.isRefreshing,
				hasNewData: inputs.hasNewDataSince(model.overviewUpdatedAtMs),
			}),
			scrollRegion(h, { className: "overflow-auto" }, [content(h, model, inputs)]),
		],
	)
})
