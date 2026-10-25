import { overviewBenchRows } from "./tanstack/bench-data"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../charts/chart"
import { bucketTooltipBody } from "../../charts/bucket-tooltip"
import { ChartSpec } from "../../charts/chart-spec"
import { plotFrame } from "../../charts/plot-frame"
import { resolveColor, ResolveThemeColors, type ThemeColors } from "../../charts/theme-colors"
import { chartSkeleton } from "../../ui/chart-skeleton"
import { isReady, type Message, type Model, toChart } from "./chart-bench"

// `/lab/bench/tanstack`: the three `/` overview
// charts on the canvas renderer off identical rows, deliberately without the linked cursor.

const CHART_CLASS = "h-[220px] w-full"
const TOKENS = [
	"--chart-throughput",
	"--chart-error",
	"--chart-p99",
	"--chart-p95",
	"--chart-p50",
	"--border",
	"--background",
]

type Kind = "Throughput" | "ErrorRate" | "Latency"

/** `overviewBenchRows` as chart rows (its index signature is `unknown`). */
const BENCH_ROWS = overviewBenchRows.map((row) => ({
	bucket: row.bucket,
	throughput: row.throughput,
	errorRate: row.errorRate,
	p50LatencyMs: row.p50LatencyMs,
	p95LatencyMs: row.p95LatencyMs,
	p99LatencyMs: row.p99LatencyMs,
}))

const CHARTS: ReadonlyArray<Readonly<{ id: string; kind: Kind; ariaLabel: string; gradientId: string }>> = [
	{
		id: "bench-throughput",
		kind: "Throughput",
		ariaLabel: "Request volume",
		gradientId: "benchThroughput",
	},
	{ id: "bench-error-rate", kind: "ErrorRate", ariaLabel: "Error rate", gradientId: "benchErrorRate" },
	{ id: "bench-latency", kind: "Latency", ariaLabel: "Latency percentiles", gradientId: "benchLatency" },
]

const colorsOf = (theme: ThemeColors): Readonly<Record<string, string>> => ({
	throughput: resolveColor(theme, "--chart-throughput"),
	error: resolveColor(theme, "--chart-error"),
	p99: resolveColor(theme, "--chart-p99"),
	p95: resolveColor(theme, "--chart-p95"),
	p50: resolveColor(theme, "--chart-p50"),
	border: resolveColor(theme, "--border"),
	background: resolveColor(theme, "--background"),
})

type ChartInputs = Readonly<{ chartId: string; ariaLabel: string; spec: ChartSpec }>

/** `PlotFrame` with `PlotTooltipBody`. */
const chartView = Submodel.defineView<Chart.Model, Chart.Message, ChartInputs>((model, inputs, h) =>
	plotFrame(h, {
		chartId: inputs.chartId,
		spec: inputs.spec,
		ariaLabel: inputs.ariaLabel,
		className: CHART_CLASS,
		tooltipBody: (portal) =>
			Option.flatMap(model.tooltip, (tooltip) =>
				tooltip._tag === "Bucket"
					? Option.some(bucketTooltipBody(h, tooltip, portal))
					: Option.none(),
			),
	}),
)

const chart = (h: HtmlBuilder<Message>, model: Model, entry: (typeof CHARTS)[number]): Html =>
	model.themeColors === null || !isReady(model)
		? h.div([h.Class(CHART_CLASS)], [chartSkeleton(h, entry.kind === "Latency" ? "line" : "area")])
		: h.submodel({
				slotId: entry.id,
				model: model.charts[entry.id] ?? Chart.init(),
				view: chartView,
				viewInputs: {
					chartId: entry.id,
					ariaLabel: entry.ariaLabel,
					spec: ChartSpec.BenchOverview({
						chart: entry.kind,
						rows: BENCH_ROWS,
						colors: colorsOf(model.themeColors),
						gradientId: entry.gradientId,
					}),
				},
				toParentMessage: toChart(entry.id),
			})

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.DataAttribute("testid", "tanstack-chart-bench"),
			h.DataAttribute("bench-renderer", "tanstack-canvas"),
			h.Class("min-h-screen bg-background p-6 text-foreground"),
			h.OnMount(ResolveThemeColors({ tokens: TOKENS })),
		],
		[
			h.div(
				[h.Class("grid grid-cols-1 gap-4")],
				CHARTS.map((entry) => chart(h, model, entry)),
			),
		],
	)
