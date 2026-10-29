import type { InfraCorrelation } from "../../../components/infra/infra-correlations"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import { INFRA_METRIC_CHART_HEIGHT, metricView as metricChartView } from "../../../charts/infra-metric-chart"
import { chartError, chartLoading, chartPlotArea } from "../../../ui/chart-state"
import { panel } from "../../../ui/panel"
import { hostSeriesSummary } from "../../infra/hosts/detail/view-panels"
import { k8sChart } from "../../infra/kit/k8s-chart"
import { ChartsBinding, type InfraCorrelationViewBuilder } from "./composition"
import type { Model } from "./model"
import { chartIdOf } from "./update"

// `renderCharts`: each group's charts, drawn as the detail charts.

type H = InfraCorrelationViewBuilder

/** Each chart component's own series label (its `*_METRIC_LABELS`), not the group's chart label. */
const SERIES_LABELS = new Map([
	["container-cpu", "CPU"],
	["container-memory_percent", "Memory / limit"],
	["container-network", "Network I/O"],
	["pod-cpu_usage", "CPU usage"],
	["pod-cpu_limit", "CPU / limit"],
	["pod-memory_limit", "Memory / limit"],
	["node-cpu_usage", "CPU usage"],
	["node-cpu_utilization", "CPU / allocatable"],
	["node-memory_utilization", "Memory / allocatable"],
	["host-cpu", "CPU"],
	["host-memory", "Memory"],
	["host-filesystem", "Disk"],
])

/** `ContainerDetailChart`, `PodDetailChart`, `NodeDetailChart`: `K8sMetricChartView` cards. */
const k8sCard = (
	h: H,
	model: Model,
	chartId: string,
	showThreshold: boolean | undefined,
	timeZone: string,
): Html =>
	k8sChart(h, {
		slot: model.series[chartId],
		chart: (slotId, viewInputs) =>
			h.block(
				ChartsBinding.embedView({
					slotId,
					key: chartId,
					model: model.charts[chartId] ?? Chart.initialModel(),
					view: metricChartView,
					viewInputs,
				}),
			),
		chartId,
		seriesLabel: SERIES_LABELS.get(chartId) ?? chartId,
		showThreshold,
		linkedChartId: chartId,
		theme: model.themeColors,
		runtime: model.chartRuntime,
		timeZone,
	})

/** `HostDetailChart` in the correlation's `Panel`: the plot area holds every state. */
const hostChart = (h: H, model: Model, chartId: string, isStacked: boolean, timeZone: string): Html => {
	const slot = model.series[chartId]
	const data = slot === undefined ? AsyncData.Idle() : slot.data
	const theme = model.themeColors
	return chartPlotArea(h, INFRA_METRIC_CHART_HEIGHT, [
		AsyncData.matchData(data, {
			onEmpty: () => chartLoading(h, { variant: "area" }),
			onFailure: (failure) => chartError(h, {}, [failure.message]),
			onData: (series) =>
				theme === null || model.chartRuntime._tag === "Loading"
					? chartLoading(h, { variant: "area" })
					: h.block(
							ChartsBinding.embedView({
								slotId: `${model.id}-${chartId}`,
								key: chartId,
								model: model.charts[chartId] ?? Chart.initialModel(),
								view: metricChartView,
								viewInputs: {
									chartId,
									rows: series.rows,
									unit: series.unit,
									seriesLabel: SERIES_LABELS.get(chartId),
									stacked: isStacked,
									showThreshold: isStacked,
									linkedChartId: chartId,
									header: hostSeriesSummary,
									isWaiting: AsyncData.isRefreshing(data),
									plotAreaHeight: INFRA_METRIC_CHART_HEIGHT,
									theme,
									timeZone,
								},
							}),
						),
		}),
	])
}

export const correlationCharts = (
	h: H,
	model: Model,
	correlation: InfraCorrelation,
	timeZone: string,
): Html => {
	const idOf = (metric: string) => chartIdOf(correlation, metric)
	const charts = (): ReadonlyArray<Html> => {
		switch (correlation.kind) {
			case "container":
				return correlation.charts.map(({ metric }) =>
					k8sCard(
						h,
						model,
						idOf(metric),
						metric === "cpu" || metric === "memory_percent",
						timeZone,
					),
				)
			case "pod":
				return correlation.charts.map(({ metric }) =>
					k8sCard(
						h,
						model,
						idOf(metric),
						metric.startsWith("cpu_") || metric.startsWith("memory_"),
						timeZone,
					),
				)
			case "node":
				return correlation.charts.map(({ metric }) =>
					k8sCard(h, model, idOf(metric), undefined, timeZone),
				)
			case "host":
				return correlation.charts.map(({ metric, label }) =>
					panel(h, { padded: true, attributes: [h.Key(idOf(metric))] }, [
						h.div([h.Class("mb-1 text-xs font-medium text-foreground")], [label]),
						hostChart(h, model, idOf(metric), metric === "cpu" || metric === "memory", timeZone),
					]),
				)
		}
	}
	return h.div([h.Class("space-y-3")], charts())
}
