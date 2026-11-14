import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { Option, Array as Arr, Record as Rec } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "@maple/views/charts/chart"
import { chartSkeleton, type ChartSkeletonVariant } from "@maple/views/ui/chart-skeleton"
import { ChartSpec, type FixedMetricRow } from "@maple/views/charts/chart-spec"
import * as FixedMetricChart from "@maple/views/charts/fixed-metric-chart"
import { latencySeries } from "@maple/views/charts/fixed-metric-legend"
import {
	fixedMetricModel,
	LATENCY_SERIES,
	throughputLegend,
	throughputPlot,
} from "@maple/views/charts/fixed-metric-series"
import { resolveColor, type ThemeColors } from "@maple/views/charts/theme-colors"
import { widgetShell } from "../widget-shell"
import { type commitMarkers, markerLayout } from "./markers"
import {
	LINKED_CURSOR_STYLE,
	LINKED_ZOOM_CLASS,
	linkedCursorOverlay,
} from "@maple/views/charts/linked-cursor"
import type { MarkerCard } from "./marker-card"
import { markersOverlay } from "./markers-view"
import { chartFrameClass } from "@maple/views/ui/chart-frame"

// The four golden-signal cards in a grid: a service's Overview tab and a release's service section feed it.

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
		title: "Error rate",
		ariaLabel: "Error rate",
		skeleton: "area",
		gradientPrefix: "errorRate",
	},
]

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
				...Rec.fromEntries(
					Arr.map(LATENCY_SERIES, (entry) => [entry.key, resolveColor(theme, entry.token)]),
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

/** The hoisted header chips: only the throughput card has two series. */
/** Every card's legend sits in its header, right side, so latency and throughput read alike. */
const headerChips = (chart: ChartConfig, rows: ReadonlyArray<FixedMetricRow>, context: GridContext) =>
	chart.kind === "Latency"
		? latencySeries(context.theme)
		: chart.kind !== "Throughput"
			? []
			: throughputLegend(
					throughputPlot(fixedMetricModel(rows, context.timeZone, context.nowMs), true),
					{
						throughput: resolveColor(context.theme, "--chart-throughput"),
						error: resolveColor(context.theme, "--chart-error"),
					},
				)

export type GridState = Readonly<{
	/** No overview yet (`Result.isInitial`), or the chart runtime and theme are still loading. */
	isLoading: boolean
	isWaiting: boolean
	context: GridContext | null
}>

/** What any page's `MetricsGrid` over the four golden-signal cards needs (services, a release). */
export type GridInput<M> = Readonly<{
	charts: Readonly<Record<string, Chart.Model>>
	rows: ReadonlyArray<FixedMetricRow>
	markers: ReturnType<typeof commitMarkers>
	/** The page's marker hover card; without it the markers draw idle. */
	markerCard?: MarkerCard<M>
	toChartMessage: (chartId: string, message: Chart.Message) => M
	/** `h.OnMount(MountLinkedZoom(...))`, lifted to the page's Message. */
	linkedCursorMount: Parameters<HtmlBuilder<M>["OnMount"]>[0]
}>

const chartBody = <M>(
	h: HtmlBuilder<M>,
	input: GridInput<M>,
	chart: ChartConfig,
	context: GridContext,
): Html => {
	const { rows, markers } = input
	const chartModel = input.charts[chart.id] ?? Chart.init()
	const overlay =
		markers.length === 0
			? undefined
			: Option.match(chartModel.plot, {
					onNone: () => undefined,
					onSome: (plot) =>
						markersOverlay(
							h,
							markerLayout(markers, plot),
							plot,
							undefined,
							"all",
							input.markerCard === undefined
								? undefined
								: { ...input.markerCard, scope: `markers-${chart.id}` },
						),
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
					className: chartFrameClass("fill"),
					reportPlot: true,
				},
				toParentMessage: (message: Chart.Message) => input.toChartMessage(chart.id, message),
			}),
			// Beside the chart, not its `overlay` input: the marker card's handlers must bind to this
			// page, and the plot box fills this wrapper, so the plot geometry lines up as is.
			overlay ?? null,
			linkedCursorOverlay(h, chart.id),
		],
	)
}

/** The four cards in a 2-column grid, the hover cursor linked across them. */
export const metricsGridOf = <M>(h: HtmlBuilder<M>, input: GridInput<M>, state: GridState): Html => {
	const { rows } = input
	const hasOverlay = input.markers.length > 0
	return h.div(
		[
			h.DataAttribute("metrics-grid", ""),
			h.OnMount(input.linkedCursorMount),
			...(state.isWaiting ? [h.AriaBusy(true)] : []),
			h.Class(
				cn(
					"grid grid-cols-1 md:grid-cols-2 gap-3",
					refreshingClass(state.isWaiting),
					LINKED_ZOOM_CLASS,
				),
			),
			h.Style(LINKED_CURSOR_STYLE),
		],
		Arr.map(CHARTS, (chart) => {
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
						// TODO(chart-empty): a loaded overview with no buckets shows no empty state yet.
						isChart ? chartBody(h, input, chart, context) : chartSkeleton(h, chart.skeleton),
					),
				],
			)
		}),
	)
}
