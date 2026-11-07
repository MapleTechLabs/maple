import { chartUnitFromOtel } from "@maple/views/lib/otel-units"
import { errorState } from "@maple/views/ui/error-state"
import { parseClickHouseDateTime, type TimeBounds } from "../../lib/time"
import { EMPTY_VALUE, formatNumber, formatValueByUnit } from "@maple/ui/lib/format"
import { timestamp } from "@maple/views/ui/timestamp"
import { isChartRuntimeReady } from "@maple/views/charts/chart-runtime"
import { spinner } from "@maple/views/ui/spinner"
import {
	table,
	tableBody,
	numericTableCell,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
} from "@maple/views/ui/table"
import { serviceDot } from "@maple/views/ui/values"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import { heading } from "@maple/views/ui/heading"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isAwaitingFirstData } from "@maple/views/data/keyed"
import { humanizeUnit, isCounter } from "../../lib/units"
import { seriesChart } from "../kit/series-chart"
import type { MetricEntry } from "../metrics/catalog"
import type { BreakdownRow } from "./fetch"
import { chartOf } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// The body of `MetricDetailView`: the chart section and the per-service breakdown.

type H = HtmlBuilder<Message>

const relative = (h: H, value: string, nowMs: number, timeZone: string): Html | string => {
	const ms = parseClickHouseDateTime(value)
	return ms === null ? "-" : timestamp(h, { value: ms, format: "relative", nowMs, timeZone })
}

const chartSection = (
	h: H,
	model: Model,
	entry: MetricEntry,
	bounds: TimeBounds,
	clockMs: number,
	timeZone: string,
): Html => {
	const counter = isCounter(entry)
	const unitLabel = humanizeUnit(entry.metricUnit, entry.metricName)
	const chartUnit = counter ? undefined : chartUnitFromOtel(entry.metricUnit, entry.metricName)
	const title = counter
		? `Rate (${unitLabel ? `${unitLabel} ` : ""}per second)`
		: `Average value${unitLabel ? ` (${unitLabel})` : ""}`
	const failure = failureWithoutData(model.timeseries)
	return h.section(
		[h.Class("space-y-2")],
		[
			hstack(h, { gap: "2", align: "baseline", justify: "between", wrap: true }, [
				heading(h, { level: 3, variant: "subsection" }, [title, " ", "by service"]),
				typography(h, { size: "xs", tone: "muted" }, [
					entry.serviceNames.length.toLocaleString(),
					" services ·",
					" ",
					formatNumber(entry.dataPointCount),
					" datapoints · last seen",
					" ",
					relative(h, entry.lastSeen, Math.max(model.nowMs, clockMs), timeZone),
				]),
			]),
			Option.isSome(failure)
				? errorState(h, {
						failure: failure.value,
						title: "Couldn’t load timeseries",
						onRetry: Message.ClickedRefresh(),
					})
				: seriesChart(h, {
						chartId: "local-metric-detail",
						points: Option.getOrUndefined(AsyncData.getData(model.timeseries.data)),
						window: chartOf(model, bounds),
						fill: counter ? "zero" : "sparse",
						isPending: isAwaitingFirstData(model.timeseries),
						heightClassName: "h-64",
						unit: chartUnit,
						fitYAxisToData: !counter,
						chart: model.chart,
						toChartMessage: (message) => Message.GotChartMessage({ message }),
						theme: isChartRuntimeReady(model.chartRuntime) ? model.themeColors : null,
						nowMs: model.nowMs,
					}),
		],
	)
}

const breakdownRow = (h: H, row: BreakdownRow, chartUnit: string | undefined, showSum: boolean): Html =>
	tableRow(h, [
		tableCell(
			h,
			[
				row.name
					? hstack(h, { gap: "1.5", align: "center", as: "span" }, [
							serviceDot(h, { serviceName: row.name, size: "sm" }),
							row.name,
						])
					: EMPTY_VALUE,
			],
			"font-mono text-xs",
		),
		numericTableCell(h, [formatValueByUnit(row.avgValue, chartUnit)]),
		...(showSum ? [numericTableCell(h, [formatValueByUnit(row.sumValue, chartUnit)])] : []),
		numericTableCell(h, [row.count.toLocaleString()]),
	])

const breakdownSection = (h: H, model: Model, entry: MetricEntry): Html => {
	const counter = isCounter(entry)
	const chartUnit = counter ? undefined : chartUnitFromOtel(entry.metricUnit, entry.metricName)
	// A total of cumulative counter readings means nothing; histograms' sums do.
	const showSum = entry.metricType === "histogram" || entry.metricType === "exponential_histogram"
	const failure = failureWithoutData(model.breakdown)
	const body = (): Html => {
		if (isAwaitingFirstData(model.breakdown))
			return hstack(h, { align: "center", justify: "center", className: "h-24 rounded-md border" }, [
				spinner(h),
			])
		if (Option.isSome(failure))
			return errorState(h, {
				failure: failure.value,
				title: "Couldn’t load breakdown",
				onRetry: Message.ClickedRefresh(),
			})
		const rows = Option.getOrElse(AsyncData.getData(model.breakdown.data), () => [])
		return h.div(
			[h.Class("rounded-md border")],
			[
				table(h, {}, [
					tableHeader(h, [
						tableRow(h, [
							tableHead(h, ["Service"]),
							tableHead(h, [counter ? "Avg reading" : "Avg"], "text-right"),
							...(showSum ? [tableHead(h, ["Sum"], "text-right")] : []),
							tableHead(h, ["Datapoints"], "text-right"),
						]),
					]),
					tableBody(
						h,
						Arr.map(rows, (row) => breakdownRow(h, row, chartUnit, showSum)),
					),
				]),
			],
		)
	}
	return h.section(
		[h.Class("space-y-2")],
		[heading(h, { level: 3, variant: "subsection" }, ["Breakdown by service"]), body()],
	)
}

/** The loaded metric: description, chart and breakdown. */
export const detailBody = (
	h: H,
	model: Model,
	entry: MetricEntry,
	bounds: TimeBounds,
	clockMs: number,
	timeZone: string,
): Html =>
	h.div(
		[h.Class("space-y-6 p-4")],
		[
			...(entry.metricDescription
				? [typography(h, { as: "p", size: "sm", tone: "muted" }, [entry.metricDescription])]
				: []),
			chartSection(h, model, entry, bounds, clockMs, timeZone),
			breakdownSection(h, model, entry),
		],
	)
