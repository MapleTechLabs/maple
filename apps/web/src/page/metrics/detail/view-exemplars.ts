import type { MetricExemplarRow } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Chart from "@maple/views/charts/chart"
import type { TimeseriesAxisSpec } from "@maple/views/charts/chart-spec"
import { exemplarOverlay } from "@maple/views/charts/exemplar-overlay"
import * as HeatmapChart from "@maple/views/charts/heatmap-chart"
import { isChartRuntimeReady } from "@maple/views/charts/chart-runtime"
import { button } from "@maple/views/ui/button"
import { chartFrameClass } from "@maple/views/ui/chart-frame"
import { chartSkeleton } from "@maple/views/ui/chart-skeleton"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeletonList } from "@maple/views/ui/skeleton"
import { hstack, hstackClass, vstack } from "@maple/views/ui/stack"
import {
	numericTableCell,
	rowLink,
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
	truncatedTableCell,
} from "@maple/views/ui/table"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../../route"
import {
	bucketMs,
	distributionCells,
	lineValuesByMs,
	timeGrid,
	chartExemplars,
	exemplarDots,
	exemplarKey,
	exemplarTime,
	exemplarsFitChart,
	valueFormat,
} from "./exemplars"
import { Message } from "./message"
import type { MetricDistribution, Model } from "./model"

type H = HtmlBuilder<Message>

/** A histogram's chart choice: its aggregation's line, or the bucket heatmap. */
export const displayToggle = (h: H, model: Model): Html =>
	segmentedSelect(h, {
		ariaLabel: "Chart",
		size: "xs",
		value: model.search.display === "distribution" ? "distribution" : "line",
		options: [
			{ value: "line", label: "Line" },
			{ value: "distribution", label: "Distribution" },
		],
		onChange: (display) => Message.ChangedChartDisplay({ display }),
	})

/** The exemplars the chart draws, one per time bucket. */
const exemplarRows = (model: Model): ReadonlyArray<MetricExemplarRow> =>
	chartExemplars(Option.getOrElse(AsyncData.getData(model.exemplars.data), () => []))

/** Dots over the line chart, once it reported its plot, when its line reads in an observation's unit. */
export const exemplarChartOverlay = (
	h: H,
	model: Model,
	aggregation: string,
	metricType: string,
	unit: string | undefined,
	timeZone: string,
): Html | undefined => {
	const rows = exemplarRows(model)
	if (rows.length === 0 || !exemplarsFitChart(aggregation, metricType)) return undefined
	return Option.match(model.chart.plot, {
		onNone: () => undefined,
		onSome: (plot) =>
			exemplarOverlay(h, {
				plot,
				dots: exemplarDots(
					rows,
					valueFormat(unit),
					timeZone,
					lineValuesByMs(Option.getOrElse(AsyncData.getData(model.timeseries.data), () => [])),
				),
				activeMs: Option.getOrUndefined(Option.map(model.chart.activeKey, bucketMs)),
				onSelect: (key) => {
					const row = Arr.findFirst(rows, (candidate) => exemplarKey(candidate) === key)
					return Option.match(row, {
						onNone: () => Message.ClearedCellSelection(),
						onSome: (exemplar) =>
							Message.ClickedExemplar({ traceId: exemplar.traceId, spanId: exemplar.spanId }),
					})
				},
			}),
	})
}

/** The line's highest value, 0 before it loaded. */
const lineMax = (model: Model): number =>
	Option.match(AsyncData.getData(model.timeseries.data), {
		onNone: () => 0,
		onSome: (rows) =>
			Math.max(
				0,
				...Arr.flatMap(rows, (row) =>
					Arr.filter(Rec.values(row), (value): value is number => typeof value === "number"),
				),
			),
	})

/** How far above the line the axis stretches for exemplars; higher ones pin to the top edge. */
const STRETCH_OVER_LINE = 4

/**
 * The line chart's axis when dots show: stretched to the highest exemplar so it stays on the
 * plot, but at most a few times the line's own top, so one outlier cannot flatten the line.
 */
export const exemplarAxis = (
	model: Model,
	aggregation: string,
	metricType: string,
): TimeseriesAxisSpec | undefined => {
	const rows = exemplarRows(model)
	if (rows.length === 0 || !exemplarsFitChart(aggregation, metricType)) return undefined
	const highest = Math.max(...Arr.map(rows, (row) => row.value))
	const top = lineMax(model)
	return {
		thresholds: [],
		logScale: false,
		softMin: null,
		softMax: top > 0 ? Math.min(highest, top * STRETCH_OVER_LINE) : highest,
		fitYAxisToData: false,
	}
}

/** The heatmap's cells, row labels and every time column of the window. */
const heatmapData = (distribution: MetricDistribution, window: Model["window"], unit: string | undefined) => {
	const { cells, labels } = distributionCells(distribution.rows, valueFormat(unit))
	return {
		data: cells,
		yLabels: labels,
		xDomain: window === null ? undefined : timeGrid(window, distribution.bucketSeconds),
	}
}

/** The bucket heatmap: time across, value buckets up, observations as colour. A cell picks exemplars. */
export const distributionBody = (h: H, model: Model, unit: string | undefined, timeZone: string): Html =>
	AsyncData.matchData(model.distribution.data, {
		onEmpty: () => chartSkeleton(h, "area"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load the distribution",
				onRetry: Message.ClickedRetryChart(),
			}),
		onData: (distribution) =>
			distribution.rows.length === 0
				? emptyMessage(h, { className: hstackClass({ justify: "center", className: "h-full" }) }, [
						"No bucketed observations in this window",
					])
				: model.themeColors === null || !isChartRuntimeReady(model.chartRuntime)
					? chartSkeleton(h, "area")
					: h.submodel({
							slotId: "metric-distribution",
							model: model.distributionChart,
							view: HeatmapChart.view,
							toParentMessage: (message: Chart.Message) =>
								Message.GotDistributionChartMessage({ message }),
							viewInputs: {
								chartId: "metric-distribution",
								...heatmapData(distribution, model.window, unit),
								theme: model.themeColors,
								timeZone,
								// A flame ramp: low counts and outliers stay distinct from the bulk.
								colorScale: "magma",
								scaleType: "log",
								className: chartFrameClass("fill"),
							},
						}),
	})

/** Rows the table lists; a picked heatmap cell lists the rest. */
const TABLE_ROWS = 10

const exemplarTable = (
	h: H,
	rows: ReadonlyArray<MetricExemplarRow>,
	unit: string | undefined,
	timeZone: string,
): Html => {
	const format = valueFormat(unit)
	return table(h, { size: "sm", ariaLabel: "Exemplars" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Time"]),
				tableHead(h, ["Value"], "text-right"),
				tableHead(h, ["Service"]),
				tableHead(h, ["Trace"], "hidden md:table-cell"),
			]),
		]),
		tableBody(
			h,
			Arr.map(rows, (row) =>
				tableRow(
					h,
					[
						tableCell(h, [
							rowLink(
								h,
								{
									href: hrefOf(
										AppRoute.Trace({
											traceId: row.traceId,
											search: { spanId: row.spanId },
										}),
									),
									label: `Open the trace behind ${format(row.value)}`,
								},
								[
									typography(h, { mono: true, size: "xs" }, [
										exemplarTime(row.timestamp, timeZone),
									]),
								],
							),
						]),
						numericTableCell(h, [typography(h, { mono: true, size: "xs" }, [format(row.value)])]),
						truncatedTableCell(h, [
							typography(h, { size: "xs", truncate: true }, [row.serviceName]),
						]),
						// The row links to its trace already; narrow screens drop the id.
						tableCell(
							h,
							[
								typography(
									h,
									{
										mono: true,
										size: "xs",
										tone: "muted",
										attributes: [h.Title(row.traceId)],
									},
									[Str.slice(0, 16)(row.traceId)],
								),
							],
							"hidden md:table-cell",
						),
					],
					undefined,
					[h.Key(exemplarKey(row))],
				),
			),
		),
	])
}

/** The traces behind the metric's highest values, or the picked heatmap cell's traces. */
export const exemplarsPanel = (
	h: H,
	model: Model,
	unit: string | undefined,
	timeZone: string,
	showsDistribution: boolean,
): Html => {
	const cell = showsDistribution ? model.selectedCell : null
	const source = cell === null ? model.exemplars : model.cellExemplars
	return panel(h, {}, [
		panelHeader(h, {
			title: "Exemplars",
			action:
				cell === null
					? typography(h, { size: "xs", tone: "muted" }, [
							showsDistribution
								? "Pick a cell to see the traces in it"
								: "Traces recorded with the highest values",
						])
					: hstack(h, { gap: "2", align: "center" }, [
							typography(h, { size: "xs", tone: "muted" }, ["In the picked cell"]),
							button(
								h,
								{
									variant: "ghost",
									size: "xs",
									attributes: [h.OnClick(Message.ClearedCellSelection())],
								},
								["Show all"],
							),
						]),
		}),
		AsyncData.matchData(source.data, {
			onEmpty: () =>
				h.div([h.Class("p-3")], [skeletonList(h, { rows: 4, rowClassName: "h-6", gap: "2" })]),
			onFailure: (failure) =>
				errorState(h, {
					failure,
					title: "Couldn't load exemplars",
					variant: "inline",
					className: "p-3",
				}),
			onData: (rows) => {
				if (rows.length === 0)
					return emptyMessage(h, { className: "p-6" }, [
						cell === null
							? "No exemplars in this window. SDKs record them on histograms and sums when a sampled span is active."
							: "No exemplars were recorded in this cell.",
					])
				const shown = Arr.take(rows, TABLE_ROWS)
				return vstack(h, { gap: "0" }, [
					exemplarTable(h, shown, unit, timeZone),
					...(rows.length > shown.length
						? [
								typography(
									h,
									{ size: "xs", tone: "muted", as: "p", className: "px-3 py-2" },
									[
										`The ${shown.length} highest of ${countLabel(rows.length, "exemplar")}; the chart marks the highest in each bucket.`,
									],
								),
							]
						: []),
				])
			},
		}),
	])
}
