import { mergeExactThroughput } from "@maple/web-data/warehouse/custom-charts"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import { chartSkeleton, type ChartSkeletonVariant } from "../../../ui/chart-skeleton"
import { ChartSpec, type FixedMetricRow } from "../../../charts/chart-spec"
import * as FixedMetricChart from "../../../charts/fixed-metric-chart"
import {
	type FixedMetricSeries,
	fixedMetricModel,
	LATENCY_SERIES,
	throughputLegend,
	throughputPlot,
} from "../../../charts/fixed-metric-series"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { widgetShell } from "../../overview/view-widget"
import { commitMarkers, markerLayout } from "./derive-markers"
import { MountLinkedCursor } from "./linked-cursor"
import { markersOverlay } from "./view-markers"
import { Message } from "./message"
import type { DetailPoint, Model } from "./model"

// `MetricsGrid` as the Overview tab feeds it (`SERVICE_CHARTS`, `syncId`, `overlay`, `yAxisWidth={72}`).

export const CHART_TOKENS = [
	"--chart-throughput",
	"--chart-error",
	"--chart-apdex",
	"--chart-p99",
	"--chart-p95",
	"--chart-p50",
	"--border",
	"--background",
]

const Y_AXIS_WIDTH = 72

type Kind = "Latency" | "Throughput" | "Apdex" | "ErrorRate"

const CHARTS: ReadonlyArray<{
	readonly id: string
	readonly kind: Kind
	readonly title: string
	readonly ariaLabel: string
	readonly skeleton: ChartSkeletonVariant
	readonly gradientPrefix: string
	readonly titleHint?: { text: string; href: string }
}> = [
	{
		id: "latency",
		kind: "Latency",
		title: "Latency",
		ariaLabel: "Latency percentiles",
		skeleton: "line",
		gradientPrefix: "latency",
	},
	{
		id: "throughput",
		kind: "Throughput",
		title: "Throughput",
		ariaLabel: "Throughput",
		skeleton: "area",
		gradientPrefix: "throughput",
	},
	{
		id: "apdex",
		kind: "Apdex",
		title: "Apdex",
		ariaLabel: "Apdex score",
		skeleton: "area",
		gradientPrefix: "apdex",
		titleHint: {
			text: "The share of requests that were fast enough to keep a user happy, scored from 0 to 1 against a 500ms target. Slow and failed requests pull it down.",
			href: "https://maple.dev/docs/alerting/apdex-alerts",
		},
	},
	{
		id: "error-rate",
		kind: "ErrorRate",
		title: "Error Rate",
		ariaLabel: "Error rate",
		skeleton: "area",
		gradientPrefix: "errorRate",
	},
]

/** The overview series with the exact pre-sampling volume merged by bucket (`mergeExactThroughput`). */
export const mergedPoints = (model: Model): ReadonlyArray<DetailPoint> => {
	const base = AsyncData.getOrElse(
		AsyncData.map(model.overview.data, (data) => data.points),
		() => [],
	)
	const exact = AsyncData.getOrElse(model.refinement.data, () => [])
	return mergeExactThroughput(base, new Map(exact.map((point) => [point.bucket, point.throughput])))
}

type ChartConfig = (typeof CHARTS)[number]

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

export type GridContext = Readonly<{ theme: ThemeColors; timeZone: string; nowMs: number }>

const specOf = (chart: ChartConfig, rows: ReadonlyArray<FixedMetricRow>, context: GridContext) =>
	ChartSpec.FixedMetric({
		chart: chart.kind,
		marginLeft: Y_AXIS_WIDTH,
		rows,
		colors: colorsOf(chart.kind, context.theme),
		perSecond: chart.kind === "Throughput",
		timeZone: context.timeZone,
		nowMs: context.nowMs,
		gradientPrefix: chart.gradientPrefix,
		showTooltip: true,
	})

/** `FixedMetricLegend`: the latency card's always-on strip under the plot. */
const fixedMetricLegend = <M>(h: HtmlBuilder<M>, series: ReadonlyArray<FixedMetricSeries>): Html =>
	h.div(
		[h.Class("flex flex-wrap gap-x-3 gap-y-0.5 pt-2 text-xs")],
		series.map((entry) =>
			h.span(
				[h.Key(entry.key), h.Class("flex items-center gap-1.5 px-1 py-0.5")],
				[
					h.span([
						h.Class(
							cn("size-2 shrink-0 rounded-xs", entry.dashed === true && "border border-dashed"),
						),
						h.Style(
							entry.dashed === true
								? { "border-color": entry.color }
								: { "background-color": entry.color },
						),
					]),
					h.span([h.Class("truncate")], [entry.label]),
				],
			),
		),
	)

const latencySeries = (theme: ThemeColors): ReadonlyArray<FixedMetricSeries> =>
	LATENCY_SERIES.map((entry) => ({
		key: entry.key,
		label: entry.label,
		color: resolveColor(theme, entry.token),
	}))

/** The hoisted header chips (`usePlotLegendSlot`): only the throughput card has two series. */
const headerChips = (chart: ChartConfig, rows: ReadonlyArray<FixedMetricRow>, context: GridContext) =>
	chart.kind !== "Throughput"
		? []
		: throughputLegend(throughputPlot(fixedMetricModel(rows, context.timeZone, context.nowMs), true), {
				throughput: resolveColor(context.theme, "--chart-throughput"),
				error: resolveColor(context.theme, "--chart-error"),
			})

/** `LinkedCursorOverlay`: positioned and shown by `MountLinkedCursor`. */
const linkedCursorOverlay = (h: HtmlBuilder<Message>, id: string): Html =>
	h.div(
		[
			h.AriaHidden(true),
			h.Class("pointer-events-none absolute"),
			h.DataAttribute("linked-cursor-overlay", id),
			h.Style({ "container-type": "inline-size", opacity: "var(--linked-cursor-visible)" }),
		],
		[
			h.div([
				h.Class("absolute inset-y-0 left-0 w-px bg-muted-foreground/45 will-change-transform"),
				h.Style({ transform: "translateX(calc(var(--linked-cursor-ratio) * (100cqw - 1px)))" }),
			]),
		],
	)

export type GridState = Readonly<{
	/** No overview yet (`Result.isInitial`), or the chart runtime and theme are still loading. */
	isLoading: boolean
	isWaiting: boolean
	context: GridContext | null
}>

const chartBody = (
	h: HtmlBuilder<Message>,
	model: Model,
	chart: ChartConfig,
	rows: ReadonlyArray<FixedMetricRow>,
	context: GridContext,
	markers: ReturnType<typeof commitMarkers>,
): Html => {
	const chartModel = model.charts[chart.id] ?? Chart.init()
	const overlay =
		markers.length === 0
			? undefined
			: Option.match(chartModel.plot, {
					onNone: () => undefined,
					onSome: (plot) => markersOverlay(h, markerLayout(markers, plot), plot),
				})
	return h.div(
		[h.Class("relative h-full min-h-0 w-full")],
		[
			h.submodel({
				slotId: `chart-${chart.id}`,
				model: chartModel,
				view: FixedMetricChart.view,
				viewInputs: {
					chartId: chart.id,
					ariaLabel: chart.ariaLabel,
					spec: specOf(chart, rows, context),
					className: "h-full w-full aspect-auto",
					legend:
						chart.kind === "Latency"
							? fixedMetricLegend(h, latencySeries(context.theme))
							: undefined,
					overlay,
					reportPlot: true,
				},
				toParentMessage: (message: Chart.Message) =>
					Message.GotChartMessage({ chartId: chart.id, message }),
			}),
			linkedCursorOverlay(h, chart.id),
		],
	)
}

export const metricsGrid = (h: HtmlBuilder<Message>, model: Model, state: GridState): Html => {
	const points = mergedPoints(model)
	const rows: ReadonlyArray<FixedMetricRow> = points.map((point) => ({ ...point }))
	const overview = AsyncData.getData(model.overview.data)
	const markers = Option.match(overview, {
		onNone: () => [],
		onSome: (data) =>
			commitMarkers(
				data.releases,
				points.map((point) => point.bucket),
				model.commits,
			),
	})
	const hasOverlay = markers.length > 0
	return h.div(
		[
			h.DataAttribute("metrics-grid", ""),
			h.OnMount(MountLinkedCursor()),
			...(state.isWaiting ? [h.AriaBusy(true)] : []),
			h.Class(cn("grid grid-cols-1 md:grid-cols-2 gap-3", refreshingClass(state.isWaiting))),
			h.Style({ "--linked-cursor-ratio": "0", "--linked-cursor-visible": "0" }),
		],
		CHARTS.map((chart) => {
			const context = state.context
			const isChart = !state.isLoading && context !== null
			return h.div(
				[
					h.Key(chart.id),
					h.DataAttribute("linked-cursor-chart", chart.id),
					h.Class("h-[240px] md:h-[280px]"),
				],
				[
					widgetShell(
						h,
						{
							title: chart.title,
							titleHint: chart.titleHint,
							legend: isChart ? headerChips(chart, rows, context) : [],
							contentClassName: hasOverlay ? "flex-1 min-h-0 p-2 overflow-visible" : undefined,
						},
						// TODO(chart-empty): `ChartEmpty` for a loaded overview with no buckets is not ported.
						isChart
							? chartBody(h, model, chart, rows, context, markers)
							: chartSkeleton(h, chart.skeleton),
					),
				],
			)
		}),
	)
}
