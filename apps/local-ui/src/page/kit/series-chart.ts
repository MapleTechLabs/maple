import { type GapFill, pivotSeries, type SeriesPoint } from "../../lib/chart-series"
import type { ChartWindow } from "../../lib/time"
import { cn } from "@maple/ui/lib/utils"
import * as AreaChart from "@maple/web/charts/area-chart"
import type { ThemeColors } from "@maple/web/charts/theme-colors"
import { chartSkeleton } from "@maple/web/ui/chart-skeleton"
import type { Html, HtmlBuilder } from "foldkit/html"

// The series chart: the pivot, gap handling and the
// loading / not-enough-data states the detail pages share, over `QueryBuilderLineChart`.

/** The tokens the line chart resolves; a page reads them with `ResolveThemeColors`. */
export const SERIES_CHART_TOKENS = AreaChart.AREA_CHART_TOKENS

export type SeriesChartOptions = Readonly<{
	chartId: string
	points: ReadonlyArray<SeriesPoint> | undefined
	window: ChartWindow
	fill: GapFill
	isPending: boolean
	heightClassName?: string
	unit?: string
	/** Metric detail only; other charts keep the default axis. */
	fitYAxisToData?: boolean
	/**
	 * Embeds the chart through the caller's own ChartBlock Binding, e.g.
	 * `(viewInputs) => h.block(ChartBinding.embedView({ slotId: seriesChartSlotId(id), model, view: AreaChart.view, viewInputs }))`.
	 */
	renderChart: (viewInputs: AreaChart.AreaChartInputs) => Html
	/** Theme colours and the chart runtime; null until both are ready (the skeleton stays up). */
	theme: ThemeColors | null
	/** The clock the in-flight tail is judged against. */
	nowMs: number
}>

/** The slot id the chart was embedded under before Blocks; callers keep it stable. */
export const seriesChartSlotId = (chartId: string): string => `series-chart-${chartId}`

export const seriesChart = <M>(h: HtmlBuilder<M>, options: SeriesChartOptions): Html => {
	const heightClassName = options.heightClassName ?? "h-56"
	const rows = pivotSeries(options.points ?? [], options.window, options.fill)
	const skeleton = h.div([h.Class("rounded-md border p-3")], [chartSkeleton(h, "line", heightClassName)])
	if (options.isPending) return skeleton
	if (rows.length < 2)
		return h.div(
			[
				h.Class(
					cn(
						"flex items-center justify-center rounded-md border text-sm text-muted-foreground",
						heightClassName,
					),
				),
			],
			["No datapoints in this range yet."],
		)
	if (options.theme === null) return skeleton
	return h.div(
		[h.Class("rounded-md border p-3")],
		[
			options.renderChart({
				chartId: options.chartId,
				data: rows,
				theme: options.theme,
				unit: options.unit,
				nowMs: options.nowMs,
				className: cn(heightClassName, "w-full"),
				legend: "visible",
				mark: "line",
				curveType: "monotone",
				...(options.fitYAxisToData === undefined
					? undefined
					: {
							axis: {
								thresholds: [],
								logScale: false,
								softMin: null,
								softMax: null,
								fitYAxisToData: options.fitYAxisToData,
							},
						}),
			}),
		],
	)
}
