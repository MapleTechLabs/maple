import type { Html, HtmlBuilder } from "foldkit/html"
import { ChartSpec, type FixedMetricRow } from "../../../charts/chart-spec"
import * as FixedMetricChart from "../../../charts/fixed-metric-chart"
import {
	fixedMetricModel,
	LATENCY_SERIES,
	throughputLegend,
	throughputPlot,
} from "../../../charts/fixed-metric-series"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import type { LegendItem } from "./tile-shell"
import type { TileContext, TileWidget } from "./tiles"

// The fixed-metric registry entries inside a widget (`LatencyLineChart`, `ThroughputAreaChart`,
// `ApdexAreaChart`, `ErrorRateAreaChart`): their own series, hoisted into the card header.

type Kind = "Latency" | "Throughput" | "Apdex" | "ErrorRate"

const KINDS = new Map<string, Readonly<{ kind: Kind; ariaLabel: string; gradientPrefix: string }>>([
	["latency-line", { kind: "Latency", ariaLabel: "Latency percentiles", gradientPrefix: "latency" }],
	["throughput-area", { kind: "Throughput", ariaLabel: "Throughput", gradientPrefix: "throughput" }],
	["apdex-area", { kind: "Apdex", ariaLabel: "Apdex score", gradientPrefix: "apdex" }],
	["error-rate-area", { kind: "ErrorRate", ariaLabel: "Error rate", gradientPrefix: "errorRate" }],
])

export const isServiceChart = (chartId: string): boolean => KINDS.has(chartId)

/** Every custom property the four charts read. */
export const SERVICE_CHART_TOKENS: ReadonlyArray<string> = [
	"--chart-throughput",
	"--chart-error",
	"--chart-apdex",
	"--chart-p99",
	"--chart-p95",
	"--chart-p50",
	"--border",
	"--background",
]

const colorsOf = (kind: Kind, theme: ThemeColors): Readonly<Record<string, string>> => {
	const chrome = {
		border: resolveColor(theme, "--border"),
		background: resolveColor(theme, "--background"),
	}
	switch (kind) {
		case "Latency":
			return {
				...chrome,
				...Object.fromEntries(
					LATENCY_SERIES.map((entry) => [entry.key, resolveColor(theme, entry.token)]),
				),
			}
		case "Throughput":
			return {
				...chrome,
				throughput: resolveColor(theme, "--chart-throughput"),
				error: resolveColor(theme, "--chart-error"),
			}
		case "Apdex":
			return { ...chrome, apdexScore: resolveColor(theme, "--chart-apdex") }
		case "ErrorRate":
			return { ...chrome, errorRate: resolveColor(theme, "--chart-error") }
	}
}

const toRows = (data: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<FixedMetricRow> =>
	data.map((row) =>
		Object.fromEntries(
			Object.entries(row).flatMap(([key, value]) =>
				typeof value === "number" ||
				typeof value === "string" ||
				typeof value === "boolean" ||
				value === null
					? [[key, value] as const]
					: [],
			),
		),
	)

/** What a hidden legend hoists into the header (`usePlotLegendSlot`). */
export const serviceLegend = (
	chartId: string,
	data: ReadonlyArray<Record<string, unknown>>,
	theme: ThemeColors,
	timeZone: string,
	nowMs: number,
): ReadonlyArray<LegendItem> => {
	const entry = KINDS.get(chartId)
	if (entry === undefined) return []
	switch (entry.kind) {
		case "Latency":
			return LATENCY_SERIES.map((series) => ({
				key: series.key,
				label: series.label,
				color: resolveColor(theme, series.token),
			}))
		case "Throughput":
			return throughputLegend(throughputPlot(fixedMetricModel(toRows(data), timeZone, nowMs), false), {
				throughput: resolveColor(theme, "--chart-throughput"),
				error: resolveColor(theme, "--chart-error"),
			})
		default:
			return []
	}
}

export const serviceChart = <M>(
	h: HtmlBuilder<M>,
	ctx: TileContext<M>,
	widget: TileWidget,
	chartId: string,
	data: ReadonlyArray<Record<string, unknown>>,
	theme: ThemeColors,
	nowMs: number,
	className: string,
): Html => {
	const entry = KINDS.get(chartId) ?? {
		kind: "Latency",
		ariaLabel: "Latency percentiles",
		gradientPrefix: "latency",
	}
	return h.submodel({
		slotId: `chart-${widget.id}`,
		model: ctx.chart,
		toParentMessage: ctx.onChart,
		view: FixedMetricChart.view,
		viewInputs: {
			chartId: widget.id,
			ariaLabel: entry.ariaLabel,
			className,
			spec: ChartSpec.FixedMetric({
				chart: entry.kind,
				rows: toRows(data),
				colors: colorsOf(entry.kind, theme),
				perSecond: false,
				timeZone: ctx.timeZone,
				nowMs,
				gradientPrefix: `${entry.gradientPrefix}-${widget.id}`,
				showTooltip: widget.display.chartPresentation?.tooltip !== "hidden",
			}),
		},
	})
}
