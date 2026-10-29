import type { ChartWindow } from "../../lib/time"
import { fillGoldenSignals } from "../../lib/golden-signals"
import { ChartSpec } from "@maple/web/charts/chart-spec"
import * as FixedMetricChart from "@maple/web/charts/fixed-metric-chart"
import { fixedMetricLegend, latencySeries } from "@maple/web/charts/fixed-metric-legend"
import { LATENCY_SERIES } from "@maple/web/charts/fixed-metric-series"
import { resolveColor, type ThemeColors } from "@maple/web/charts/theme-colors"
import { chartSkeleton } from "@maple/web/ui/chart-skeleton"
import type { Html } from "foldkit/html"
import {
	ApdexChartBinding,
	ErrorRateChartBinding,
	LatencyChartBinding,
	type ServiceDetailViewBuilder,
	ThroughputChartBinding,
} from "./composition"
import type { GoldenSignalRow, Model } from "./model"

// The golden signals: the four charts web's service
// page opens with, `LatencyLineChart`, `ThroughputAreaChart`, `ApdexAreaChart`, `ErrorRateAreaChart`.

const GOLDEN_CHART_CLASS = "h-44 w-full"

type Kind = "Latency" | "Throughput" | "Apdex" | "ErrorRate"

const TILES: ReadonlyArray<
	Readonly<{ id: string; kind: Kind; title: string; ariaLabel: string; gradientPrefix: string }>
> = [
	{
		id: "latency",
		kind: "Latency",
		title: "Latency",
		ariaLabel: "Latency percentiles",
		gradientPrefix: "latency",
	},
	{
		id: "throughput",
		kind: "Throughput",
		title: "Throughput",
		ariaLabel: "Throughput",
		gradientPrefix: "throughput",
	},
	{ id: "apdex", kind: "Apdex", title: "Apdex", ariaLabel: "Apdex score", gradientPrefix: "apdex" },
	{
		id: "error-rate",
		kind: "ErrorRate",
		title: "Error rate",
		ariaLabel: "Error rate",
		gradientPrefix: "errorRate",
	},
]

/** The tokens the golden charts and the operations chart read off the theme. */
export const GOLDEN_TOKENS = [
	"--chart-throughput",
	"--chart-error",
	"--chart-apdex",
	"--chart-p99",
	"--chart-p95",
	"--chart-p50",
]

const colorsOf = (kind: Kind, theme: ThemeColors): Readonly<Record<string, string>> => {
	const chrome = {
		border: resolveColor(theme, "--border"),
		background: resolveColor(theme, "--background"),
	}
	if (kind === "Latency")
		return {
			...chrome,
			...Object.fromEntries(
				LATENCY_SERIES.map((entry) => [entry.key, resolveColor(theme, entry.token)]),
			),
		}
	if (kind === "Throughput")
		return {
			...chrome,
			throughput: resolveColor(theme, "--chart-throughput"),
			error: resolveColor(theme, "--chart-error"),
		}
	if (kind === "Apdex") return { ...chrome, apdexScore: resolveColor(theme, "--chart-apdex") }
	return { ...chrome, errorRate: resolveColor(theme, "--chart-error") }
}

export type ChartContext = Readonly<{ theme: ThemeColors; nowMs: number }>

/** Each tile embeds the chart its own Binding holds. */
const embedTile = (
	h: ServiceDetailViewBuilder,
	model: Model,
	kind: Kind,
	slotId: string,
	viewInputs: FixedMetricChart.FixedMetricChartInputs,
): Html => {
	const view = FixedMetricChart.view
	if (kind === "Latency")
		return h.block(LatencyChartBinding.embedView({ slotId, model: model.latencyChart, view, viewInputs }))
	if (kind === "Throughput")
		return h.block(
			ThroughputChartBinding.embedView({ slotId, model: model.throughputChart, view, viewInputs }),
		)
	if (kind === "Apdex")
		return h.block(ApdexChartBinding.embedView({ slotId, model: model.apdexChart, view, viewInputs }))
	return h.block(ErrorRateChartBinding.embedView({ slotId, model: model.errorRateChart, view, viewInputs }))
}

const tileChart = (
	h: ServiceDetailViewBuilder,
	model: Model,
	tile: (typeof TILES)[number],
	rows: ReadonlyArray<Readonly<Record<string, string | number>>>,
	context: ChartContext,
): Html =>
	embedTile(h, model, tile.kind, `golden-${tile.id}`, {
		chartId: tile.id,
		ariaLabel: tile.ariaLabel,
		className: GOLDEN_CHART_CLASS,
		spec: ChartSpec.FixedMetric({
			chart: tile.kind,
			rows,
			colors: colorsOf(tile.kind, context.theme),
			perSecond: tile.kind === "Throughput",
			timeZone: null,
			nowMs: context.nowMs,
			gradientPrefix: tile.gradientPrefix,
			showTooltip: true,
		}),
		legend: tile.kind === "Latency" ? fixedMetricLegend(h, latencySeries(context.theme)) : undefined,
	})

/** Pending (or the chart runtime and theme not ready yet) draws the area skeleton in each tile. */
export const goldenSignals = (
	h: ServiceDetailViewBuilder,
	model: Model,
	rows: ReadonlyArray<GoldenSignalRow>,
	window: ChartWindow,
	isPending: boolean,
	context: ChartContext | null,
): Html => {
	const points = fillGoldenSignals(rows, window).map((point) => ({ ...point }))
	return h.section(
		[h.Class("grid gap-3 md:grid-cols-2")],
		TILES.map((tile) =>
			h.div(
				[h.Key(tile.title), h.Class("space-y-2 rounded-md border p-3")],
				[
					h.h3([h.Class("text-sm font-medium")], [tile.title]),
					isPending || context === null
						? chartSkeleton(h, "area", GOLDEN_CHART_CLASS)
						: tileChart(h, model, tile, points, context),
				],
			),
		),
	)
}
