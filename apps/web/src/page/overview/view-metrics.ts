import { mergeExactThroughput } from "@maple/web-data/warehouse/custom-charts"
import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { Option, Struct } from "effect"
import { AsyncData as FoldkitAsyncData, Mount } from "foldkit"
import { createKeyedLazy, type Html, type HtmlBuilder } from "foldkit/html"
import * as Chart from "../../charts/chart"
import { chartSkeleton, type ChartSkeletonVariant } from "../../ui/chart-skeleton"
import { chartEmpty } from "../../ui/chart-state"
import * as FixedMetricChart from "../../charts/fixed-metric-chart"
import type { FixedMetricChartInputs } from "../../charts/fixed-metric-chart"
import { LINKED_CURSOR_STYLE, linkedCursorOverlay, MountLinkedCursor } from "../../charts/linked-cursor"
import {
	fixedMetricModel,
	type FixedMetricSeries,
	LATENCY_SERIES,
	throughputLegend,
	throughputPlot,
} from "../../charts/fixed-metric-series"
import { ChartSpec, type FixedMetricRow } from "../../charts/chart-spec"
import { resolveColor, type ThemeColors } from "../../charts/theme-colors"
import { FAILURE_KEY_SEPARATOR, failureKey, type LoadFailure } from "../../data/load-failure"
import { errorState } from "../../ui/error-state"
import { presenceOf } from "../kit/signal-presence"
import { stableSlice } from "../kit/stable-slice"
import { Message, type RetryTarget } from "./message"
import type { Model, OverviewPoint } from "./model"
import { widgetShell } from "./view-widget"

type MetricsData = Pick<Model, "overviewSeries" | "logSeries" | "refinement" | "presence">
type CardId = "throughput" | "error-rate" | "latency" | "log-volume"
const CARD_IDS: ReadonlyArray<CardId> = ["throughput", "error-rate", "latency", "log-volume"]
const EMPTY_CHART = Chart.init()
const metricsDataOf = stableSlice((model: Model) =>
	Struct.pick(model, ["overviewSeries", "logSeries", "refinement", "presence"]),
)
const gridContextOf = stableSlice((context: GridContext) => context)
const cardSlot = createKeyedLazy()

// The home page's metrics grid: its four overview charts.

/** The colour tokens the four charts and their chrome read off the theme. */
export const THEME_TOKENS = [
	"--chart-throughput",
	"--chart-error",
	"--chart-p99",
	"--chart-p95",
	"--chart-p50",
	"--border",
	"--background",
]

/** The exact pre-sampling volume, merged by ISO bucket where present (`mergeExactThroughput`). */
export const overviewPoints = (model: MetricsData, useRefinement: boolean): ReadonlyArray<OverviewPoint> => {
	const base = FoldkitAsyncData.getOrElse(model.overviewSeries.data, () => [])
	const exact = useRefinement ? FoldkitAsyncData.getOrElse(model.refinement.data, () => []) : []
	return base.length === 0
		? base
		: mergeExactThroughput(base, new Map(exact.map((point) => [point.bucket, point.throughput])))
}

type Spec = FixedMetricChartInputs["spec"]

/** One card's body: the chart, its loading ghost, or the error that replaced it. */
type CardBody =
	| Readonly<{ _tag: "Loading" }>
	| Readonly<{ _tag: "Failed"; failure: LoadFailure; retry: RetryTarget }>
	| Readonly<{ _tag: "Chart"; spec: Spec; ariaLabel: string }>
	/** No rows: `NeverReceived` when the org has never sent the chart's signal; `isPresent` when it has. */
	| Readonly<{ _tag: "Empty"; isPresent: boolean }>
	| Readonly<{ _tag: "NeverReceived"; signal: "traces" | "logs" }>

export type GridItem = Readonly<{
	id: string
	title: string
	skeleton: ChartSkeletonVariant
	legend: ReadonlyArray<FixedMetricSeries>
	headerValue?: Html
	footer?: ReadonlyArray<Html | string>
	body: CardBody
}>

/** A slot read the way the grid reads it: `isInitial` is loading, `onError` is a failure. */
export const bodyOf = <A>(
	data: FoldkitAsyncData.AsyncData<A, LoadFailure>,
	retry: RetryTarget,
	toChart: (value: A) => CardBody,
): CardBody =>
	FoldkitAsyncData.match(data, {
		onIdle: (): CardBody => ({ _tag: "Loading" }),
		onLoading: (): CardBody => ({ _tag: "Loading" }),
		onFailure: (error): CardBody => ({ _tag: "Failed", failure: error, retry }),
		onStale: ({ error }): CardBody => ({ _tag: "Failed", failure: error, retry }),
		onRefreshing: (value) => toChart(value),
		onSuccess: (value) => toChart(value),
	})

export type GridContext = Readonly<{
	colors: ThemeColors
	/** Theme and chart runtime are in: before that a card shows its ghost. */
	isChartReady: boolean
	timeZone: string
	nowMs: number
	/** `overviewSamplingActive` over every environment: the refinement is merged and may fail. */
	useRefinement: boolean
	/** The strips' `failureKey`s joined (a string keeps the cards cached); a card failing the same way says so in one line. */
	pageFailureKeys: string
}>

const specOf = (
	chart: Spec["chart"],
	rows: ReadonlyArray<FixedMetricRow>,
	colors: Readonly<Record<string, string>>,
	context: GridContext,
	perSecond: boolean,
	gradientPrefix: string,
): Spec =>
	ChartSpec.FixedMetric({
		chart,
		rows,
		colors: {
			...colors,
			border: resolveColor(context.colors, "--border"),
			background: resolveColor(context.colors, "--background"),
		},
		perSecond,
		timeZone: context.timeZone,
		nowMs: context.nowMs,
		gradientPrefix,
		showTooltip: true,
	})

const throughputColors = (context: GridContext) => ({
	throughput: resolveColor(context.colors, "--chart-throughput"),
	error: resolveColor(context.colors, "--chart-error"),
})

/** The header chips a throughput chart hoists into its card (`usePlotLegendSlot`). */
const throughputChips = (rows: ReadonlyArray<FixedMetricRow>, perSecond: boolean, context: GridContext) =>
	throughputLegend(
		throughputPlot(fixedMetricModel(rows, context.timeZone, context.nowMs), perSecond),
		throughputColors(context),
	)

const latencyColors = (context: GridContext) =>
	Object.fromEntries(LATENCY_SERIES.map((entry) => [entry.key, resolveColor(context.colors, entry.token)]))

const LOADING: CardBody = { _tag: "Loading" }

/** An empty chart reads presence: a skeleton until it is known, setup copy when never received. */
const emptyBody = (model: MetricsData, signal: "traces" | "logs"): CardBody => {
	const { status } = presenceOf(model.presence, signal)
	if (status === "loading") return LOADING
	return status === "absent"
		? { _tag: "NeverReceived", signal }
		: { _tag: "Empty", isPresent: status === "present" }
}

/** The series come back zero-filled per bucket, so a never-received signal still has rows to draw. */
const isNeverReceived = (model: MetricsData, signal: "traces" | "logs"): boolean =>
	presenceOf(model.presence, signal).status === "absent"

/** Build only the card whose data or interaction state changed. */
const gridItem = (
	h: HtmlBuilder<Message>,
	model: MetricsData,
	context: GridContext,
	id: CardId,
): GridItem => {
	const chart = (body: CardBody) => (context.isChartReady || body._tag !== "Chart" ? body : LOADING)
	const throughput = throughputColors(context)
	if (id === "log-volume") {
		const rows = FoldkitAsyncData.getOrElse(model.logSeries.data, () => [])
		const body = chart(
			bodyOf(model.logSeries.data, "LogVolume", (rows): CardBody =>
				rows.length === 0 || isNeverReceived(model, "logs")
					? emptyBody(model, "logs")
					: {
							_tag: "Chart",
							spec: specOf("Throughput", rows, throughput, context, false, "log-volume"),
							ariaLabel: "Throughput",
						},
			),
		)
		return {
			id,
			title: "Log Volume",
			skeleton: "area",
			legend: body._tag === "Chart" ? throughputChips(rows, false, context) : [],
			body,
		}
	}
	const points = overviewPoints(model, context.useRefinement)
	const rows: ReadonlyArray<FixedMetricRow> = points
	const overviewBody = (spec: () => Spec, ariaLabel: string) =>
		chart(
			bodyOf(model.overviewSeries.data, "Overview", (): CardBody =>
				rows.length === 0 || isNeverReceived(model, "traces")
					? emptyBody(model, "traces")
					: { _tag: "Chart", spec: spec(), ariaLabel },
			),
		)
	const showSummary =
		!FoldkitAsyncData.isIdle(model.overviewSeries.data) &&
		!FoldkitAsyncData.isLoading(model.overviewSeries.data) &&
		!FoldkitAsyncData.isFailure(model.overviewSeries.data) &&
		!FoldkitAsyncData.isStale(model.overviewSeries.data)
	switch (id) {
		case "throughput": {
			const body = overviewBody(
				() => specOf("Throughput", rows, throughput, context, true, "throughput"),
				"Throughput",
			)
			const footerError = context.useRefinement
				? Option.map(FoldkitAsyncData.getError(model.refinement.data), (failure) =>
						errorState(h, {
							failure,
							variant: "inline",
							title: "Exact request volume unavailable",
							onRetry: Message.ClickedRetry({ target: "Refinement" }),
							className: "py-0",
						}),
					)
				: Option.none()
			return {
				id,
				title: "Request Volume",
				skeleton: "area",
				legend: body._tag === "Chart" ? throughputChips(rows, true, context) : [],
				body,
				footer: !showSummary
					? undefined
					: Option.match(footerError, {
							onNone: () => [
								"Total",
								" ",
								h.span(
									[h.Class("font-medium text-foreground tabular-nums")],
									[formatNumber(points.reduce((sum, point) => sum + point.throughput, 0))],
								),
							],
							onSome: (error) => [error],
						}),
			}
		}
		case "error-rate": {
			const total = points.reduce((sum, point) => sum + point.throughput, 0)
			const errors = points.reduce((sum, point) => sum + point.throughput * point.errorRate, 0)
			return {
				id,
				title: "Error Rate",
				skeleton: "area",
				legend: [],
				body: overviewBody(
					() =>
						specOf(
							"ErrorRate",
							rows,
							{ errorRate: throughput.error },
							context,
							false,
							"errorRate",
						),
					"Error rate",
				),
				headerValue: showSummary
					? h.span([h.Class("text-chart-error")], [formatErrorRate(total > 0 ? errors / total : 0)])
					: undefined,
			}
		}
		case "latency": {
			const body = overviewBody(
				() => specOf("Latency", rows, latencyColors(context), context, false, "latency"),
				"Latency percentiles",
			)
			return {
				id,
				title: "Latency",
				skeleton: "line",
				body,
				legend:
					body._tag === "Chart"
						? LATENCY_SERIES.map((entry) => ({
								key: entry.key,
								label: entry.label,
								color: resolveColor(context.colors, entry.token),
							}))
						: [],
			}
		}
	}
}

const cardContent = (
	h: HtmlBuilder<Message>,
	chart: Chart.Model,
	item: GridItem,
	pageFailureKeys: string,
): Html => {
	switch (item.body._tag) {
		case "Loading":
			return chartSkeleton(h, item.skeleton)
		case "Failed": {
			const { failure: cardFailure, retry } = item.body
			// The page strip already names this failure and retries it: the card keeps its frame, quietly.
			if (pageFailureKeys.split(FAILURE_KEY_SEPARATOR).includes(failureKey(cardFailure)))
				return h.div([h.Class("h-full")], [h.span([h.Class("sr-only")], ["Couldn't load"])])
			return errorState(h, {
				failure: cardFailure,
				variant: "panel",
				className: "border-0",
				onRetry: Message.ClickedRetry({ target: retry }),
			})
		}
		case "Empty":
			// A wider window only helps when the signal was seen; a failed presence read says nothing.
			return chartEmpty(h, item.body.isPresent ? { hint: "Try a wider time range" } : {}, [
				"No data in this window",
			])
		case "NeverReceived":
			return chartEmpty(h, { hint: "Fills in once Maple receives them" }, [
				`No ${item.body.signal} yet`,
			])
		case "Chart": {
			const { spec, ariaLabel } = item.body
			return h.div(
				[h.Class("relative h-full min-h-0 w-full")],
				[
					h.submodel({
						slotId: `chart-${item.id}`,
						model: chart,
						view: FixedMetricChart.view,
						viewInputs: {
							chartId: item.id,
							ariaLabel,
							spec,
							className: "h-full w-full aspect-auto",
						},
						toParentMessage: (message: Chart.Message) =>
							Message.GotChartMessage({ chartId: item.id, message }),
					}),
					linkedCursorOverlay(h, item.id),
				],
			)
		}
	}
}

const metricCard = (
	h: HtmlBuilder<Message>,
	id: CardId,
	data: MetricsData,
	context: GridContext,
	chart: Chart.Model,
): Html => {
	const item = gridItem(h, data, context, id)
	return h.div(
		[h.Key(id), h.DataAttribute("linked-cursor-chart", id), h.Class("h-[240px] md:h-[280px]")],
		[
			widgetShell(
				h,
				{
					title: item.title,
					legend: item.legend,
					headerValue: item.headerValue,
					footer: item.footer,
				},
				cardContent(h, chart, item, context.pageFailureKeys),
			),
		],
	)
}

/** Cache each card separately: a tooltip update rebuilds only its own card. */
export const metricsGrid = (h: HtmlBuilder<Message>, model: Model, context: GridContext): Html => {
	const data = metricsDataOf(model)
	const gridContext = gridContextOf(context)
	const isWaiting =
		FoldkitAsyncData.isRefreshing(model.overviewSeries.data) ||
		FoldkitAsyncData.isRefreshing(model.logSeries.data)
	return h.div(
		[
			h.DataAttribute("metrics-grid", ""),
			...(isWaiting ? [h.AriaBusy(true)] : []),
			h.Class(cn("grid grid-cols-1 md:grid-cols-2 gap-3", refreshingClass(isWaiting), "mt-4")),
			h.Style(LINKED_CURSOR_STYLE),
			h.OnMount(Mount.mapMessage(MountLinkedCursor(), () => Message.CompletedMountLinkedCursor())),
		],
		CARD_IDS.map((id) =>
			cardSlot(id, metricCard, [h, id, data, gridContext, model.charts[id] ?? EMPTY_CHART]),
		),
	)
}
