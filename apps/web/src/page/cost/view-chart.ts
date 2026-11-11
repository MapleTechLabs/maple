import type { CostTimeseriesResponse } from "@maple/domain/http"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as BarChart from "@maple/views/charts/bar-chart"
import type * as Chart from "@maple/views/charts/chart"
import { chartEmpty, chartLoading } from "@maple/views/ui/chart-state"
import { errorState } from "@maple/views/ui/error-state"
import { panelChartBody } from "@maple/views/ui/panel"
import { chartCard } from "../kit/chart-card"
import { lastBy } from "../kit/last-by"
import { chartRows, type CostGroupBy, DIMENSIONS, formatDay, groupByOf, isEmptySeries } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

const CHART_ID = "cost-daily-chart"
/** The plot and its legend under it. */
const CHART_HEIGHT = 300

/** The chart's rows, kept while the answer and the grouping are: a hover re-renders over the same array. */
const rowsOf = lastBy(([response, dimension]: readonly [CostTimeseriesResponse, CostGroupBy]) =>
	chartRows(response, dimension),
)

/** Under the title: the unit of the bars, and what the lighter ones mean. */
const descriptionOf = (model: Model): string => {
	const totals = Option.getOrUndefined(AsyncData.getData(model.totals.data))
	const response = Option.getOrUndefined(AsyncData.getData(model.timeseries.data))
	const unit =
		totals === undefined || totals.currency === "" || totals.mixedCurrencies
			? "Per UTC day."
			: `${totals.currency} per UTC day.`
	const estimatedFrom = response?.estimatedFrom ?? null
	return estimatedFrom === null
		? unit
		: `${unit} Lighter bars from ${formatDay(estimatedFrom)} are not final yet.`
}

const plot = (h: H, model: Model, response: CostTimeseriesResponse): Html => {
	const theme = model.chartRuntime._tag === "Ready" ? model.themeColors : null
	if (theme === null) return chartLoading(h, { variant: "bar", height: CHART_HEIGHT })
	return h.div(
		[h.Class("w-full"), h.Style({ height: `${CHART_HEIGHT}px` })],
		[
			h.submodel({
				slotId: CHART_ID,
				model: model.chart,
				view: BarChart.view,
				viewInputs: {
					chartId: CHART_ID,
					data: rowsOf([response, groupByOf(model.search)]),
					theme,
					// Cost days are UTC calendar days, whatever the viewer's zone.
					timeZone: "UTC",
					nowMs: model.nowMs,
					stacked: true,
					legend: "visible",
				},
				toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ message }),
			}),
		],
	)
}

/** Stacked bars per UTC day, one series per key of the grouping, the tail folded into "Other". */
export const dailyChart = (h: H, model: Model): Html =>
	chartCard(
		h,
		{
			title: `Daily cost by ${DIMENSIONS[groupByOf(model.search)].noun}`,
			description: descriptionOf(model),
		},
		[
			panelChartBody(h, [
				AsyncData.matchData(model.timeseries.data, {
					onEmpty: () => chartLoading(h, { variant: "bar", height: CHART_HEIGHT }),
					onFailure: (failure) =>
						errorState(h, {
							failure,
							title: "Couldn't load daily cost",
							onRetry: Message.ClickedRetry(),
						}),
					onData: (response) =>
						isEmptySeries(response)
							? chartEmpty(h, { height: CHART_HEIGHT }, ["No cost in this window"])
							: plot(h, model, response),
				}),
			]),
		],
	)
