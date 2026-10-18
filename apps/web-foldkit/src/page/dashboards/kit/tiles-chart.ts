// BOUNDARY: chart tiles render whatever their endpoint answered; rows are untyped query results.
import type { DashboardDocument } from "@maple/domain/http"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as AreaChart from "../../../charts/area-chart"
import * as BarChart from "../../../charts/bar-chart"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import * as FunnelChart from "../../../charts/funnel-chart"
import * as FunnelDropoffChart from "../../../charts/funnel-dropoff-chart"
import * as HbarChart from "../../../charts/hbar-chart"
import * as HeatmapChart from "../../../charts/heatmap-chart"
import * as HistogramChart from "../../../charts/histogram-chart"
import * as PathsChart from "../../../charts/paths-chart"
import * as PieChart from "../../../charts/pie-chart"
import { hoistedSeries } from "../../../charts/timeseries"
import { chartSkeleton, type ChartSkeletonVariant } from "../../../ui/chart-skeleton"
import { type ChartCategory, chartCategoryOf } from "./chart-registry"
import { widgetEmptyState, widgetFrame } from "./tile-shell"
import type { TileContext } from "./tiles"
import { frame } from "./tiles-frame"

// `makeChartWidget` (dashboard-builder/widgets/make-chart-widget.tsx): one factory for every widget
// that mounts a registry chart, each branch handing its chart only the settings it declares.
// TODO(chart-axes): line/area/bar thresholds, log scale and soft bounds are not drawn yet.
// TODO(service-charts): the fixed-metric registry entries (latency-line, throughput-area, apdex,
// error rate) draw their skeleton inside a widget.

type Widget = DashboardDocument["widgets"][number]
type Rows = ReadonlyArray<Record<string, unknown>>
type Primitive = Readonly<Record<string, string | number | boolean>>

export type ChartWidgetOptions = Readonly<{
	defaultChartId: string
	defaultLegend?: "visible" | "hidden" | "right" | undefined
	className?: string | undefined
}>

const CHART_WIDGET: ChartWidgetOptions = { defaultChartId: "query-builder-line", defaultLegend: "hidden" }

export const CHART_WIDGETS = {
	chart: CHART_WIDGET,
	pie: { defaultChartId: "query-builder-pie", defaultLegend: "right" },
	histogram: { defaultChartId: "query-builder-histogram" },
	heatmap: { defaultChartId: "query-builder-heatmap", className: "h-full w-full" },
	funnel: { defaultChartId: "query-builder-funnel" },
	paths: { defaultChartId: "query-builder-paths", className: "h-full w-full" },
	hbar: { defaultChartId: "query-builder-hbar" },
} satisfies Readonly<Record<string, ChartWidgetOptions>>

const primitiveRows = (rows: Rows): ReadonlyArray<Primitive> =>
	rows.map((row) =>
		Object.fromEntries(
			Object.entries(row).flatMap(([key, value]) =>
				typeof value === "string" || typeof value === "number" || typeof value === "boolean"
					? [[key, value] as const]
					: [],
			),
		),
	)

const skeletonOf = (category: ChartCategory, widget: Widget): ChartSkeletonVariant =>
	category === "funnel" && widget.display.funnel?.variant === "dropoff" ? "funnel-dropoff" : category

const SERVICE_CHART_IDS = new Set(["latency-line", "throughput-area", "apdex-area", "error-rate-area"])

/** Charts drawn on the canvas need the theme and the chart runtime; the DOM ones do not. */
const isCanvas = (category: ChartCategory) =>
	category === "line" ||
	category === "area" ||
	category === "bar" ||
	category === "pie" ||
	category === "histogram" ||
	category === "heatmap"

type Render = Readonly<{
	category: ChartCategory
	data: Rows
	className: string
	legend: "visible" | "hidden" | "right" | undefined
}>

const chartView = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, widget: Widget, render: Render): Html => {
	const display = widget.display
	const presentation = display.chartPresentation
	const tooltip = presentation?.tooltip
	const common = { slotId: `chart-${widget.id}`, model: ctx.chart, toParentMessage: ctx.onChart }
	const theme = ctx.themeColors
	const { data, className } = render
	if (isCanvas(render.category) && (theme === null || !isChartRuntimeReady(ctx.chartRuntime)))
		return chartSkeleton(h, skeletonOf(render.category, widget))
	switch (render.category) {
		case "line":
		case "area": {
			if (theme === null || ctx.nowMs === null) return chartSkeleton(h, render.category)
			return h.submodel({
				...common,
				view: AreaChart.view,
				viewInputs: {
					chartId: widget.id,
					data: primitiveRows(data),
					theme,
					unit: display.unit,
					timeZone: ctx.timeZone,
					nowMs: ctx.nowMs,
					className,
					showTooltip: tooltip !== "hidden",
					legend: render.legend ?? "hidden",
					mark: render.category,
					...(render.category === "area" ? { stacked: display.stacked === true } : {}),
					curveType: display.curveType === "monotone" ? "monotone" : "linear",
					...(presentation?.showPoints === undefined ? {} : { showPoints: presentation.showPoints }),
					seriesStats: presentation?.seriesStats === true,
				},
			})
		}
		case "bar": {
			if (theme === null || ctx.nowMs === null) return chartSkeleton(h, "bar")
			return h.submodel({
				...common,
				view: BarChart.view,
				viewInputs: {
					chartId: widget.id,
					data: primitiveRows(data),
					theme,
					unit: display.unit,
					timeZone: ctx.timeZone,
					nowMs: ctx.nowMs,
					stacked: display.stacked === true,
					className,
					showTooltip: tooltip !== "hidden",
				},
			})
		}
		case "pie":
			return theme === null
				? chartSkeleton(h, "pie")
				: h.submodel({
						...common,
						view: PieChart.view,
						viewInputs: {
							chartId: widget.id,
							data,
							theme,
							className,
							...(render.legend === undefined ? {} : { legend: render.legend }),
							...(tooltip === undefined ? {} : { tooltip }),
							...(display.unit === undefined ? {} : { unit: display.unit }),
							...(display.pie?.donut === undefined ? {} : { donut: display.pie.donut }),
							...(display.pie?.innerRadius === undefined ? {} : { innerRadius: display.pie.innerRadius }),
							...(display.pie?.showLabels === undefined ? {} : { showLabels: display.pie.showLabels }),
							...(display.pie?.showPercent === undefined ? {} : { showPercent: display.pie.showPercent }),
						},
					})
		case "histogram":
			return theme === null
				? chartSkeleton(h, "histogram")
				: h.submodel({
						...common,
						view: HistogramChart.view,
						viewInputs: {
							chartId: widget.id,
							data,
							theme,
							className,
							...(tooltip === undefined ? {} : { tooltip }),
							...(display.unit === undefined ? {} : { unit: display.unit }),
							...(display.yAxis?.logScale === undefined ? {} : { logScale: display.yAxis.logScale }),
							...(display.histogram?.bucketCount === undefined ? {} : { bucketCount: display.histogram.bucketCount }),
							...(display.histogram?.bucketWidth === undefined ? {} : { bucketWidth: display.histogram.bucketWidth }),
							...(display.histogram?.logScaleY === undefined ? {} : { logScaleY: display.histogram.logScaleY }),
						},
					})
		case "heatmap":
			return theme === null
				? chartSkeleton(h, "heatmap")
				: h.submodel({
						...common,
						view: HeatmapChart.view,
						viewInputs: {
							chartId: widget.id,
							data,
							theme,
							className,
							tooltip,
							unit: display.unit,
							colorScale: display.heatmap?.colorScale,
							scaleType: display.heatmap?.scaleType,
						},
					})
		case "funnel": {
			const inputs = {
				data,
				className,
				unit: display.unit,
				showStepPercent: display.funnel?.showStepPercent,
			}
			return display.funnel?.variant === "dropoff"
				? h.submodel({ ...common, view: FunnelDropoffChart.view, viewInputs: inputs })
				: h.submodel({ ...common, view: FunnelChart.view, viewInputs: inputs })
		}
		case "paths":
			return h.submodel({
				...common,
				view: PathsChart.view,
				viewInputs: { data, className, direction: display.paths?.direction },
			})
		case "hbar":
			return h.submodel({ ...common, view: HbarChart.view, viewInputs: { data, className, unit: display.unit } })
	}
}

/** One chart widget: the frame, the empty state when nothing is chartable, else the chart. */
export const chartWidgetTile = <M>(
	h: HtmlBuilder<M>,
	ctx: TileContext<M>,
	widget: Widget,
	options: ChartWidgetOptions,
): Html => {
	const chartId = widget.display.chartId ?? options.defaultChartId
	const category = chartCategoryOf(chartId)
	const skeleton = chartSkeleton(h, category === undefined ? "line" : skeletonOf(category, widget))
	const state = ctx.state
	const data: Rows | undefined =
		state._tag === "Ready" && state.data !== null && state.data._tag === "Rows" ? state.data.rows : undefined
	const legend = widget.display.chartPresentation?.legend ?? options.defaultLegend
	const isTimeseries = category === "line" || category === "area" || category === "bar"
	const hoists = isTimeseries && legend !== "visible" && legend !== "right"
	const legendItems =
		hoists && data !== undefined && data.length > 0 && ctx.themeColors !== null && !SERVICE_CHART_IDS.has(chartId)
			? hoistedSeries(data, ctx.themeColors)
			: undefined
	const options_ = frame(ctx, widget, { loadingSkeleton: skeleton, legendItems })
	return widgetFrame(h, options_, () => {
		if (category === undefined) return []
		if (data === undefined || data.length === 0) return [widgetEmptyState(h)]
		if (SERVICE_CHART_IDS.has(chartId)) return [skeleton]
		return [chartView(h, ctx, widget, { category, data, className: options.className ?? "h-full w-full aspect-auto", legend })]
	})
}
