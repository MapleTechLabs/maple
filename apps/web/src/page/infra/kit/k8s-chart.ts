import { cn } from "@maple/ui/lib/utils"
import { formatValueWithUnit } from "../../../components/infra/chart-units"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import type { ChartRuntime } from "../../../charts/chart-runtime"
import type { ThemeColors } from "../../../charts/theme-colors"
import { panel } from "../../../ui/panel"
import {
	type InfraSeriesInfo,
	metricView as metricChartView,
	titledHeader,
} from "../../../charts/infra-metric-chart"
import { chartError, chartLoading } from "../../../ui/chart-state"
import type { SeriesSlot } from "./series"
import { seriesLegend } from "../../kit/series-legend"

// `K8sMetricChartView` and the detail-chart wrappers around it: one metric at a time, 280 tall, series legend,
// in a `ChartCard`.

export const K8S_CHART_HEIGHT = 280

/** `K8sSeriesSummary`: the series legend above the plot. */
const k8sSeriesSummary = (h: HtmlBuilder<Chart.Message>, info: InfraSeriesInfo, className = "mb-3"): Html =>
	seriesLegend(h, {
		className: cn("justify-start", className),
		items: info.series.map((name) => {
			const value = info.lastValues[name]
			return {
				key: name,
				label: info.labelFor(name),
				color: info.colors.get(name),
				value: value === undefined ? undefined : formatValueWithUnit(value, info.unit),
			}
		}),
	})

export type K8sChartOptions<M> = Readonly<{
	slot: SeriesSlot | undefined
	chart: Chart.Model | undefined
	toChart: (message: Chart.Message) => M
	chartId: string
	seriesLabel: string
	/** An eyebrow title beside the legend, for charts not already titled by their section. */
	title?: string
	showThreshold?: boolean
	stacked?: boolean
	/** `syncId` given: the chart joins the page's linked cursor under this id. */
	linkedChartId?: string
	height?: number
	theme: ThemeColors | null
	runtime: ChartRuntime
	timeZone: string
}>

export const k8sChart = <M>(h: HtmlBuilder<M>, options: K8sChartOptions<M>): Html => {
	const height = options.height ?? K8S_CHART_HEIGHT
	const data = options.slot?.data ?? AsyncData.Idle()
	const theme = options.theme
	return AsyncData.matchData(data, {
		onEmpty: () => chartLoading(h, { variant: "area", height: height }),
		onFailure: (failure) => chartError(h, { height: height }, [failure.message]),
		onData: (series) =>
			theme === null || options.runtime._tag === "Loading"
				? chartLoading(h, { variant: "area", height: height })
				: panel(h, { className: "p-4" }, [
						h.submodel({
							slotId: `k8s-chart-${options.chartId}`,
							model: options.chart ?? Chart.init(),
							view: metricChartView,
							toParentMessage: options.toChart,
							viewInputs: {
								chartId: options.chartId,
								rows: series.rows,
								unit: series.unit,
								seriesLabel: options.seriesLabel,
								stacked: options.stacked,
								showThreshold: options.showThreshold,
								linkedChartId: options.linkedChartId,
								header:
									options.title === undefined
										? k8sSeriesSummary
										: titledHeader(options.title, (hb, info) =>
												k8sSeriesSummary(hb, info, ""),
											),
								isWaiting: AsyncData.isRefreshing(data),
								height,
								theme,
								timeZone: options.timeZone,
							},
						}),
					]),
	})
}
