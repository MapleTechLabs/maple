import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import * as InfraMetricChart from "../../../charts/infra-metric-chart"
import type { ChartUnit, LongRow } from "../../../charts/infra-metric-series"
import type { ThemeColors } from "../../../charts/theme-colors"
import { chartLoading } from "../../../ui/chart-state"
import { chartCard } from "./chart-card"

// A detail page's grid of bucketed metric charts, one card per chart, two columns from `lg`.

type Bucketed = { readonly bucket: string }

/** A picked `null` is a gap: that bucket draws nothing for the series. */
export type MetricSeries<Row> = readonly [label: string, pick: (row: Row) => number | null]

export interface MetricChart<Row> {
	/** The card title, and the key of the chart's model. */
	readonly id: string
	readonly unit: ChartUnit
	readonly series: ReadonlyArray<MetricSeries<Row>>
}

const GRID = "grid grid-cols-1 gap-4 lg:grid-cols-2"

/** One long row per (bucket, series), leaving out the gaps. */
export const metricChartRows = <Row extends Bucketed>(
	chart: MetricChart<Row>,
	buckets: ReadonlyArray<Row>,
): ReadonlyArray<LongRow> =>
	buckets.flatMap((row) =>
		chart.series.flatMap(([label, pick]) => {
			const value = pick(row)
			return value === null ? [] : [{ bucket: row.bucket, attributeValue: label, value }]
		}),
	)

/** Whether any bucket has a value for any of the chart's series. */
export const hasMetricData = <Row extends Bucketed>(chart: MetricChart<Row>, buckets: ReadonlyArray<Row>) =>
	buckets.some((row) => chart.series.some(([, pick]) => pick(row) !== null))

export const metricChartsLoading = <M>(h: HtmlBuilder<M>, count: number): Html =>
	h.div(
		[h.Class(GRID)],
		Array.from({ length: count }, () => chartLoading(h, { variant: "line", height: 256 })),
	)

export type MetricChartCardsOptions<Row, M> = Readonly<{
	/** Prefixes the slot, chart and gradient ids. */
	idPrefix: string
	/** Charts sharing it move their hover crosshair together. */
	linkedChartId: string
	charts: ReadonlyArray<MetricChart<Row>>
	buckets: ReadonlyArray<Row>
	models: Readonly<Record<string, Chart.Model>>
	toMessage: (chartId: string, message: Chart.Message) => M
	theme: ThemeColors
	timeZone: string
	isWaiting: boolean
}>

export const metricChartCards = <Row extends Bucketed, M>(
	h: HtmlBuilder<M>,
	options: MetricChartCardsOptions<Row, M>,
): Html => {
	const xDomain = options.buckets.map((row) => row.bucket)
	return h.div(
		[h.Class(GRID)],
		options.charts.map((chart, index) =>
			chartCard(h, { title: chart.id }, [
				h.submodel({
					slotId: `${options.idPrefix}-chart-${index}`,
					model: options.models[chart.id] ?? Chart.init(),
					view: InfraMetricChart.view,
					toParentMessage: (message: Chart.Message) => options.toMessage(chart.id, message),
					viewInputs: {
						chartId: `${options.idPrefix}-${index}`,
						spec: InfraMetricChart.infraMetricSpec({
							rows: metricChartRows(chart, options.buckets),
							unit: chart.unit,
							xDomain,
							theme: options.theme,
							timeZone: options.timeZone,
							gradientPrefix: `${options.idPrefix}-${index}`,
						}),
						linkedChartId: options.linkedChartId,
						isWaiting: options.isWaiting,
					},
				}),
			]),
		),
	)
}
