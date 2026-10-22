// BOUNDARY: chart tiles render whatever their endpoint answered; rows are untyped query results.
import type { Html, HtmlBuilder } from "foldkit/html"
import * as AreaChart from "../../../charts/area-chart"
import * as BarChart from "../../../charts/bar-chart"
import { bucketBarSeries } from "../../../charts/bar-chart"
import { OTHER_LABEL } from "@maple/ui/components/charts/_shared/bucket-series"
import * as Chart from "../../../charts/chart"
import { type ChartRuntime, isChartRuntimeReady } from "../../../charts/chart-runtime"
import * as FunnelChart from "../../../charts/funnel-chart"
import * as FunnelDropoffChart from "../../../charts/funnel-dropoff-chart"
import * as HbarChart from "../../../charts/hbar-chart"
import * as HeatmapChart from "../../../charts/heatmap-chart"
import * as HistogramChart from "../../../charts/histogram-chart"
import * as PathsChart from "../../../charts/paths-chart"
import * as PieChart from "../../../charts/pie-chart"
import { hoistedSeries } from "../../../charts/timeseries"
import type { TimeseriesAxisSpec } from "../../../charts/chart-spec"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { validateCssColor } from "@maple/ui/lib/sanitizers"
import { chartSkeleton, type ChartSkeletonVariant } from "../../../ui/chart-skeleton"
import { type ChartCategory, chartCategoryOf } from "./chart-registry"
import { widgetEmptyState, widgetFrame } from "./tile-shell"
import type { TileContext, TileWidget } from "./tiles"
import { frame } from "./tiles-frame"
import { isServiceChart, serviceChart, serviceLegend } from "./tiles-service"

// `makeChartWidget`: one factory for every widget
// that mounts a registry chart, each branch handing its chart only the settings it declares.
// TODO(chart-axes): line/area/bar thresholds, log scale and soft bounds are not drawn yet.

type Widget = TileWidget
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
			Object.entries(row).flatMap(
				([key, value]): ReadonlyArray<readonly [string, string | number | boolean]> =>
					typeof value === "string" || typeof value === "boolean"
						? [[key, value] as const]
						: // `asFiniteNumber`: a null or NaN reading is plotted as 0, the key kept in place.
							typeof value === "number" || value === null
							? [
									[
										key,
										typeof value === "number" && Number.isFinite(value) ? value : 0,
									] as const,
								]
							: [],
			),
		),
	)

const skeletonOf = (category: ChartCategory, widget: Widget): ChartSkeletonVariant =>
	category === "funnel" && widget.display.funnel?.variant === "dropoff" ? "funnel-dropoff" : category

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

/** `canvasSafeThresholdColor`: a validated colour resolved to a literal, else `--destructive`. */
const thresholdColor = (theme: ThemeColors, color: string | undefined): string => {
	const fallback = resolveColor(theme, "--destructive")
	const validated = validateCssColor(color)
	if (validated === null || validated === undefined) return fallback
	const resolved = resolveColor(theme, validated, fallback)
	return /var\(|currentcolor/i.test(resolved) ? fallback : resolved
}

/** The cartesian block every line, area and bar chart reads (`renderChart`'s `cartesian`). */
const axisSpecOf = (widget: Widget, theme: ThemeColors): TimeseriesAxisSpec => ({
	thresholds: (widget.display.thresholds ?? []).map((threshold) => ({
		value: threshold.value,
		color: thresholdColor(theme, threshold.color),
		label: threshold.label ?? null,
	})),
	logScale: widget.display.yAxis?.logScale === true,
	softMin: widget.display.yAxis?.softMin ?? null,
	softMax: widget.display.yAxis?.softMax ?? null,
	fitYAxisToData: widget.display.yAxis?.fitYAxisToData === true,
})

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
					...(render.category === "area" ? { stacked: display.stacked === true } : undefined),
					curveType: display.curveType === "monotone" ? "monotone" : "linear",
					...(presentation?.showPoints === undefined
						? undefined
						: { showPoints: presentation.showPoints }),
					seriesStats: presentation?.seriesStats === true,
					axis: axisSpecOf(widget, theme),
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
					legend: render.legend ?? "hidden",
					seriesStats: presentation?.seriesStats === true,
					axis: axisSpecOf(widget, theme),
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
							...(render.legend === undefined ? undefined : { legend: render.legend }),
							...(tooltip === undefined ? undefined : { tooltip }),
							...(display.unit === undefined ? undefined : { unit: display.unit }),
							...(display.pie?.donut === undefined ? undefined : { donut: display.pie.donut }),
							...(display.pie?.innerRadius === undefined
								? undefined
								: { innerRadius: display.pie.innerRadius }),
							...(display.pie?.showLabels === undefined
								? undefined
								: { showLabels: display.pie.showLabels }),
							...(display.pie?.showPercent === undefined
								? undefined
								: { showPercent: display.pie.showPercent }),
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
							...(tooltip === undefined ? undefined : { tooltip }),
							...(display.unit === undefined ? undefined : { unit: display.unit }),
							...(display.yAxis?.logScale === undefined
								? undefined
								: { logScale: display.yAxis.logScale }),
							...(display.histogram?.bucketCount === undefined
								? undefined
								: { bucketCount: display.histogram.bucketCount }),
							...(display.histogram?.bucketWidth === undefined
								? undefined
								: { bucketWidth: display.histogram.bucketWidth }),
							...(display.histogram?.logScaleY === undefined
								? undefined
								: { logScaleY: display.histogram.logScaleY }),
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
			return h.submodel({
				...common,
				view: HbarChart.view,
				viewInputs: { data, className, unit: display.unit },
			})
	}
}

export type RegistryChartInputs<M> = Readonly<{
	slot: string
	chart: Chart.Model
	onChart: (message: Chart.Message) => M
	theme: ThemeColors | null
	chartRuntime: ChartRuntime
	nowMs: number | null
	timeZone: string
	chartId: string
	data: Rows
	className: string
}>

/**
 * A registry chart with only `data` and `className` set (`ChartPreview`, the gallery thumbnails):
 * every other setting at the chart component's own default.
 */
export const registryChartView = <M>(h: HtmlBuilder<M>, inputs: RegistryChartInputs<M>): Html => {
	const category = chartCategoryOf(inputs.chartId) ?? "line"
	const widget: Widget = {
		id: inputs.slot,
		visualization: "chart",
		dataSource: null,
		display: { chartId: inputs.chartId },
	}
	const ctx: TileContext<M> = {
		h,
		state: { _tag: "Loading" },
		isEdit: false,
		menu: null,
		isMenuOpen: false,
		hasGrip: false,
		configure: null,
		chart: inputs.chart,
		themeColors: inputs.theme,
		chartRuntime: inputs.chartRuntime,
		nowMs: inputs.nowMs,
		timeZone: inputs.timeZone,
		tableSort: { key: null, dir: "desc" },
		onChart: inputs.onChart,
		onSort: () => inputs.onChart(Chart.Message.LeftChart()),
	}
	return chartView(h, ctx, widget, {
		category,
		data: inputs.data,
		className: inputs.className,
		legend: undefined,
	})
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
		state._tag === "Ready" && state.data !== null && state.data._tag === "Rows"
			? state.data.rows
			: undefined
	const legend = widget.display.chartPresentation?.legend ?? options.defaultLegend
	const isTimeseries = category === "line" || category === "area" || category === "bar"
	const hoists = isTimeseries && legend !== "visible" && legend !== "right"
	const theme = ctx.themeColors
	const legendItems =
		!hoists || data === undefined || data.length === 0 || theme === null
			? undefined
			: isServiceChart(chartId)
				? ctx.nowMs === null
					? undefined
					: serviceLegend(chartId, data, theme, ctx.timeZone, ctx.nowMs)
				: category === "bar"
					? hoistedSeries(bucketBarSeries(primitiveRows(data)), theme).map((item) =>
							item.label === OTHER_LABEL
								? { ...item, color: resolveColor(theme, "--muted-foreground") }
								: item,
						)
					: hoistedSeries(data, theme)
	const options_ = frame(ctx, widget, { loadingSkeleton: skeleton, legendItems })
	return widgetFrame(h, options_, () => {
		if (category === undefined) return []
		if (data === undefined || data.length === 0) return [widgetEmptyState(h)]
		if (isServiceChart(chartId))
			return theme === null || ctx.nowMs === null || !isChartRuntimeReady(ctx.chartRuntime)
				? [skeleton]
				: [
						serviceChart(
							h,
							ctx,
							widget,
							chartId,
							data,
							theme,
							ctx.nowMs,
							options.className ?? "h-full w-full aspect-auto",
						),
					]
		return [
			chartView(h, ctx, widget, {
				category,
				data,
				className: options.className ?? "h-full w-full aspect-auto",
				legend,
			}),
		]
	})
}
