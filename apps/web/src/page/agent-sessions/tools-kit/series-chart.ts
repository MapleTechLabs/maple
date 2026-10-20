import { formatWarehouseDateTime } from "@maple/query-engine"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { metricValue, toolChartTitle, toolMetricLabel } from "@maple/web-data/lib/tool-analytics"
import { makeBucketAxis } from "@maple/ui/components/plot/bucket-axis"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import { ChartSpec } from "../../../charts/chart-spec"
import { bucketTooltipBody } from "../../../charts/bucket-tooltip"
import { plotFrame } from "../../../charts/plot-frame"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import type { LoadFailure } from "../../../data/load-failure"
import { chartEmpty, chartLoading } from "../../../ui/chart-state"
import { errorState } from "../../../ui/error-state"
import { panelHeader } from "../../../ui/panel"
import { seriesLegend } from "../../kit/series-legend"
import type { ToolMetric, ToolPercentile, ToolSeriesPoint } from "./model"

// A tool series chart in a bare `ChartCard`.

const PLOT_HEIGHT = 220
const CHART_EMPTY_MESSAGE = "No data for this metric in the selected window."

/** The tokens the chart reads off the theme. */
export const TOOL_CHART_TOKENS = [
	"--primary",
	"--color-severity-error",
	"--muted-foreground",
	"--border",
	"--background",
]

const seriesFor = (metric: ToolMetric, percentile: ToolPercentile) =>
	metric === "duration"
		? (["p50", "p90", "p95"] as const).map((key) => ({
				key,
				label: key.toUpperCase(),
				token:
					key === percentile
						? "--primary"
						: key === "p95"
							? "--color-severity-error"
							: "--muted-foreground",
			}))
		: [{ key: metric, label: toolMetricLabel(metric, percentile), token: "--primary" }]

/** "1h" / "5m": the bucket width, as a chart note. */
const bucketLabel = (ms: number): string =>
	ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 60_000)}m`

export type SeriesChartInputs = Readonly<{
	chartId: string
	series: ReadonlyArray<ToolSeriesPoint>
	metric: ToolMetric
	percentile: ToolPercentile
	tool: string | undefined
	model: string | undefined
	isLoading: boolean
	failure: LoadFailure | undefined
	isWaiting: boolean
	theme: ThemeColors
	timeZone: string
}>

const rowsOf = (inputs: SeriesChartInputs) =>
	inputs.series
		.toSorted((a, b) => a.bucket - b.bucket)
		.map((point) => ({
			bucket: formatWarehouseDateTime(point.bucket),
			[inputs.metric]: metricValue(point, inputs.metric, inputs.percentile),
			p50: point.p50,
			p90: point.p90,
			p95: point.p95,
		}))

type ToolSeriesSpec = Extract<ChartSpec, { readonly _tag: "ToolSeries" }>

export type ToolPlotInputs = Readonly<{
	chartId: string
	ariaLabel: string
	height: number
	rows: ToolSeriesSpec["rows"]
	series: ReadonlyArray<Readonly<{ key: string; label: string; token: string }>>
	format: ToolSeriesSpec["format"]
	tickCount: number | null
	marginTop: number
	theme: ThemeColors
	timeZone: string
}>

/** `CursorPlot` at a fixed height: the lines, the crosshair and the bucket tooltip. */
export const toolPlotView = Submodel.defineView<Chart.Model, Chart.Message, ToolPlotInputs>(
	(model, inputs, h) =>
		h.div(
			[h.Class("w-full"), h.Style({ height: `${inputs.height}px` })],
			[
				plotFrame(h, {
					chartId: inputs.chartId,
					className: "h-full w-full",
					ariaLabel: inputs.ariaLabel,
					spec: ChartSpec.ToolSeries({
						rows: inputs.rows,
						series: inputs.series.map((entry) => ({
							key: entry.key,
							label: entry.label,
							color: resolveColor(inputs.theme, entry.token),
						})),
						chrome: {
							border: resolveColor(inputs.theme, "--border"),
							background: resolveColor(inputs.theme, "--background"),
						},
						format: inputs.format,
						tickCount: inputs.tickCount,
						marginTop: inputs.marginTop,
						timeZone: inputs.timeZone,
					}),
					tooltipBody: (portal) =>
						Option.flatMap(model.tooltip, (tooltip) =>
							tooltip._tag === "Bucket"
								? Option.some(bucketTooltipBody(h, tooltip, portal))
								: Option.none(),
						),
				}),
			],
		),
)

/** The chart card: the metric as its heading, the scope in the primary, the bucket note. */
export const seriesChart = <M>(
	h: HtmlBuilder<M>,
	inputs: SeriesChartInputs,
	chart: Chart.Model,
	toMessage: (message: Chart.Message) => M,
): Html => {
	const rows = rowsOf(inputs)
	const axis = makeBucketAxis(
		rows.map((row) => row.bucket),
		inputs.timeZone,
	)
	const scopeParts = [inputs.tool, inputs.model].filter((part): part is string => part !== undefined)
	const plotted = seriesFor(inputs.metric, inputs.percentile)
	const title = toolChartTitle({
		metric: inputs.metric,
		percentile: inputs.percentile,
		tool: inputs.tool,
		model: inputs.model,
	})
	const bucketMs = axis.stepMs ?? null
	return h.section(
		[
			...(inputs.isWaiting ? [h.AriaBusy(true)] : []),
			h.Class(
				cn(
					"flex min-w-0 flex-col",
					"gap-4 border-b border-border px-6 pt-[22px] pb-5",
					refreshingClass(inputs.isWaiting),
				),
			),
		],
		[
			panelHeader(h, {
				title: toolMetricLabel(inputs.metric, inputs.percentile),
				scope:
					scopeParts.length === 0
						? undefined
						: h.span(
								[h.Class("contents")],
								scopeParts.map((part) =>
									h.span(
										[h.Key(part), h.Class("contents font-mono text-xs")],
										[
											h.span(
												[
													h.AriaHidden(true),
													h.Class("text-xs text-muted-foreground/60"),
												],
												["·"],
											),
											h.span([h.Class("text-primary")], [part]),
										],
									),
								),
							),
				action: h.span(
					[h.Class("contents")],
					[
						...(plotted.length > 1
							? [
									seriesLegend(h, {
										items: plotted.map((entry) => ({
											key: entry.key,
											label: entry.label,
											color: `var(${entry.token})`,
										})),
										swatch: "square",
									}),
								]
							: []),
						h.span(
							[h.Class("font-mono text-2xs text-muted-foreground/60")],
							bucketMs === null ? [] : [`${bucketLabel(bucketMs)} buckets`],
						),
					],
				),
				divided: false,
				className: cn("px-3 pt-2.5", "px-0 pt-0"),
			}),
			inputs.failure !== undefined
				? errorState(h, { failure: inputs.failure, title: `Failed to load ${title}` })
				: inputs.isLoading && rows.length === 0
					? chartLoading(h, { variant: "line", height: PLOT_HEIGHT })
					: rows.length === 0
						? chartEmpty(h, { height: PLOT_HEIGHT }, [CHART_EMPTY_MESSAGE])
						: h.submodel({
								slotId: inputs.chartId,
								model: chart,
								view: toolPlotView,
								viewInputs: {
									chartId: inputs.chartId,
									ariaLabel: title,
									height: PLOT_HEIGHT,
									rows,
									series: plotted,
									format: inputs.metric,
									tickCount: null,
									marginTop: 4,
									theme: inputs.theme,
									timeZone: inputs.timeZone,
								},
								toParentMessage: toMessage,
							}),
		],
	)
}
