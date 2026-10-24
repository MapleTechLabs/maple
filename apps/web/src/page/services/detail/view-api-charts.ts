import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import { bucketTooltipBody } from "../../../charts/bucket-tooltip"
import { ChartSpec } from "../../../charts/chart-spec"
import * as FixedMetricChart from "../../../charts/fixed-metric-chart"
import { LATENCY_SERIES } from "../../../charts/fixed-metric-series"
import { plotFrame } from "../../../charts/plot-frame"
import * as Sparkline from "../../../charts/sparkline"
import { stackedBreakdown } from "../../../charts/stacked-breakdown-chart"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { responseRows, type StatusClass } from "./derive-api"
import type { ApiBucket } from "./model-tabs"

// The API tab's charts: the responses-by-status stack, the latency lines and the sparklines.

/** The status classes' colours; 2xx stays calm, 4xx is the warning hue, 5xx the error one. */
export const STATUS_COLORS = {
	"2xx": "var(--chart-3)",
	"4xx": "var(--warning)",
	"5xx": "var(--severity-error)",
} as const satisfies Record<StatusClass, string>

const STACK_ORDER = ["5xx", "4xx", "2xx"] as const

export const SPARK_TOKENS = {
	requests: "--chart-p50",
	client: "--warning",
	server: "--severity-error",
	latency: "--chart-p95",
	bytes: "--chart-5",
} as const

/** Every token the API tab paints on canvas; resolved once by the page's theme Mount. */
export const API_THEME_TOKENS = [
	...Object.values(SPARK_TOKENS),
	"--chart-3",
	...LATENCY_SERIES.map((series) => series.token),
	"--border",
	"--background",
]

export type ChartContext = Readonly<{ theme: ThemeColors; timeZone: string; nowMs: number }>

/** The stacked 2xx/4xx/5xx request rate, with an optional overlay (deploy markers) over the plot. */
export const statusChart = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		chartId: string
		chart: Chart.Model | undefined
		buckets: ReadonlyArray<ApiBucket>
		bucketSeconds: number
		context: ChartContext
		className: string
		overlay?: Html
		/** The chart reports its plot so the caller can lay markers over it. */
		reportPlot?: boolean
		toMessage: (message: Chart.Message) => M
	}>,
): Html => {
	const built = stackedBreakdown({
		rows: responseRows(options.buckets, options.bucketSeconds),
		colors: STATUS_COLORS,
		// Paint order is bottom up: errors sit on the axis where a small band stays visible.
		order: STACK_ORDER,
		theme: options.context.theme,
		timeZone: options.context.timeZone,
		gradientPrefix: options.chartId,
	})
	const model = options.chart ?? Chart.init()
	return h.submodel({
		slotId: options.chartId,
		model,
		view: StatusChartView,
		viewInputs: {
			chartId: options.chartId,
			spec: built.spec,
			className: options.className,
			overlay: options.overlay,
			reportPlot: options.reportPlot ?? false,
		},
		toParentMessage: options.toMessage,
	})
}

type StatusChartInputs = Readonly<{
	chartId: string
	spec: ChartSpec
	className: string
	overlay: Html | undefined
	reportPlot: boolean
}>

const StatusChartView = Submodel.defineView<Chart.Model, Chart.Message, StatusChartInputs>((model, inputs, h) =>
	plotFrame(h, {
		chartId: inputs.chartId,
		spec: inputs.spec,
		ariaLabel: "Responses by status",
		className: inputs.className,
		overlay: inputs.overlay,
		reportPlot: inputs.reportPlot,
		tooltipBody: (portal) =>
			Option.flatMap(model.tooltip, (tooltip) =>
				tooltip._tag === "Bucket" ? Option.some(bucketTooltipBody(h, tooltip, portal)) : Option.none(),
			),
	}),
)

/** One endpoint's p50/p95/p99 over the window, on the service page's latency chart. */
export const latencyChart = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		chartId: string
		chart: Chart.Model | undefined
		buckets: ReadonlyArray<ApiBucket>
		context: ChartContext
		className: string
		toMessage: (message: Chart.Message) => M
	}>,
): Html =>
	h.submodel({
		slotId: options.chartId,
		model: options.chart ?? Chart.init(),
		view: FixedMetricChart.view,
		viewInputs: {
			chartId: options.chartId,
			ariaLabel: "Latency percentiles",
			className: options.className,
			spec: ChartSpec.FixedMetric({
				chart: "Latency",
				rows: options.buckets.map((bucket) => ({
					bucket: bucket.bucket,
					p50LatencyMs: bucket.p50DurationMs,
					p95LatencyMs: bucket.p95DurationMs,
					p99LatencyMs: bucket.p99DurationMs,
				})),
				colors: {
					border: resolveColor(options.context.theme, "--border"),
					background: resolveColor(options.context.theme, "--background"),
					...Object.fromEntries(
						LATENCY_SERIES.map((series) => [series.key, resolveColor(options.context.theme, series.token)]),
					),
				},
				perSecond: false,
				timeZone: options.context.timeZone,
				nowMs: options.context.nowMs,
				gradientPrefix: options.chartId,
				showTooltip: true,
			}),
		},
		toParentMessage: options.toMessage,
	})

const SPARKLINE_MODEL = Chart.init()

/** A line sparkline in the tile or row colour; canvas, so the colour is resolved here. */
export const sparkline = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		chartId: string
		values: ReadonlyArray<number>
		token: string
		theme: ThemeColors
		className: string
		toMessage: (message: Chart.Message) => M
	}>,
): Html =>
	h.submodel({
		slotId: `spark-${options.chartId}`,
		model: SPARKLINE_MODEL,
		view: Sparkline.view,
		viewInputs: {
			chartId: options.chartId,
			values: options.values,
			color: resolveColor(options.theme, options.token),
			className: options.className,
			revision: 0,
			fillOpacity: [0.18, 0],
		},
		toParentMessage: options.toMessage,
	})
