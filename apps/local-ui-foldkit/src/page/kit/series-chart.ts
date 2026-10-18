import { type GapFill, pivotSeries, type SeriesPoint } from "@maple/local-ui/lib/chart-series"
import type { ChartWindow } from "@maple/local-ui/lib/time"
import { cn } from "@maple/ui/lib/utils"
import * as AreaChart from "@maple/web-foldkit/charts/area-chart"
import * as Chart from "@maple/web-foldkit/charts/chart"
import type { ThemeColors } from "@maple/web-foldkit/charts/theme-colors"
import { chartSkeleton } from "@maple/web-foldkit/ui/chart-skeleton"
import type { Html, HtmlBuilder } from "foldkit/html"

// apps/local-ui/src/components/series-chart.tsx: the one timeseries chart the detail pages share,
// a `QueryBuilderLineChart` over the pivoted rows, with its loading and not-enough-data states.

export type SeriesChartOptions<M> = Readonly<{
	chartId: string
	points: ReadonlyArray<SeriesPoint>
	window: ChartWindow
	fill: GapFill
	isPending: boolean
	heightClassName?: string
	unit?: string
	/** The chart's own state (tooltip, hidden legend keys), held by the page. */
	chart: Chart.Model
	toChartMessage: (message: Chart.Message) => M
	/** Theme and clock; null until the page resolved them, which keeps the skeleton up. */
	context: Readonly<{ theme: ThemeColors; nowMs: number }> | null
}>

export const seriesChart = <M>(h: HtmlBuilder<M>, options: SeriesChartOptions<M>): Html => {
	const heightClassName = options.heightClassName ?? "h-56"
	const rows = pivotSeries(options.points, options.window, options.fill)
	const context = options.context
	if (options.isPending || context === null)
		return h.div([h.Class("rounded-md border p-3")], [chartSkeleton(h, "line", heightClassName)])
	if (rows.length < 2)
		return h.div(
			[h.Class(cn("flex items-center justify-center rounded-md border text-sm text-muted-foreground", heightClassName))],
			["No datapoints in this range yet."],
		)
	return h.div(
		[h.Class("rounded-md border p-3")],
		[
			h.submodel({
				slotId: options.chartId,
				model: options.chart,
				view: AreaChart.view,
				viewInputs: {
					chartId: options.chartId,
					data: rows,
					theme: context.theme,
					unit: options.unit,
					nowMs: context.nowMs,
					className: cn(heightClassName, "w-full"),
					legend: "visible",
					mark: "line",
					curveType: "monotone",
				},
				toParentMessage: options.toChartMessage,
			}),
		],
	)
}
