import { parseClickHouseDateTime, type TimeBounds } from "../../lib/time"
import { chartUnitFromOtel, humanizeUnit, isCounter } from "../../lib/units"
import { EMPTY_VALUE, formatNumber, formatValueByUnit } from "@maple/ui/lib/format"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { isChartRuntimeReady } from "@maple/web/charts/chart-runtime"
import { spinner } from "@maple/web/ui/spinner"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/web/ui/table"
import { serviceDot } from "@maple/web/ui/values"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { seriesChart } from "../kit/series-chart"
import { errorState } from "../kit/view-states"
import type { MetricEntry } from "../metrics/catalog"
import type { BreakdownRow } from "./fetch"
import { chartOf } from "./load"
import { Message } from "./message"
import type { Model } from "./model"

// The body of `MetricDetailView`: the chart section and the per-service breakdown.

type H = HtmlBuilder<Message>

const relative = (value: string, nowMs: number): string => {
	const ms = parseClickHouseDateTime(value)
	return ms === null ? "-" : formatRelativeFrom(ms, nowMs)
}

const chartSection = (h: H, model: Model, entry: MetricEntry, bounds: TimeBounds, clockMs: number): Html => {
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
			h.div(
				[h.Class("flex flex-wrap items-baseline justify-between gap-2")],
				[
					h.h3([h.Class("text-sm font-medium")], [title, " ", "by service"]),
					h.span(
						[h.Class("text-xs text-muted-foreground")],
						[
							entry.serviceNames.length.toLocaleString(),
							" services ·",
							" ",
							formatNumber(entry.dataPointCount),
							" datapoints · last seen",
							" ",
							relative(entry.lastSeen, Math.max(model.nowMs, clockMs)),
						],
					),
				],
			),
			Option.isSome(failure)
				? errorState(h, {
						label: "timeseries",
						failure: failure.value,
						onRetry: Message.ClickedRefresh(),
					})
				: seriesChart(h, {
						chartId: "local-metric-detail",
						points: Option.getOrUndefined(AsyncData.getData(model.timeseries.data)),
						window: chartOf(model, bounds),
						fill: counter ? "zero" : "sparse",
						isPending: isPending(model.timeseries),
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
					? h.span(
							[h.Class("flex items-center gap-1.5")],
							[serviceDot(h, { serviceName: row.name, size: "sm" }), row.name],
						)
					: EMPTY_VALUE,
			],
			"font-mono text-xs",
		),
		tableCell(h, [formatValueByUnit(row.avgValue, chartUnit)], "text-right tabular-nums"),
		...(showSum
			? [tableCell(h, [formatValueByUnit(row.sumValue, chartUnit)], "text-right tabular-nums")]
			: []),
		tableCell(h, [row.count.toLocaleString()], "text-right tabular-nums"),
	])

const breakdownSection = (h: H, model: Model, entry: MetricEntry): Html => {
	const counter = isCounter(entry)
	const chartUnit = counter ? undefined : chartUnitFromOtel(entry.metricUnit, entry.metricName)
	// A total of cumulative counter readings means nothing; histograms' sums do.
	const showSum = entry.metricType === "histogram" || entry.metricType === "exponential_histogram"
	const failure = failureWithoutData(model.breakdown)
	const body = (): Html => {
		if (isPending(model.breakdown))
			return h.div([h.Class("flex h-24 items-center justify-center rounded-md border")], [spinner(h)])
		if (Option.isSome(failure))
			return errorState(h, {
				label: "breakdown",
				failure: failure.value,
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
						rows.map((row) => breakdownRow(h, row, chartUnit, showSum)),
					),
				]),
			],
		)
	}
	return h.section(
		[h.Class("space-y-2")],
		[h.h3([h.Class("text-sm font-medium")], ["Breakdown by service"]), body()],
	)
}

/** The loaded metric: description, chart and breakdown. */
export const detailBody = (
	h: H,
	model: Model,
	entry: MetricEntry,
	bounds: TimeBounds,
	clockMs: number,
): Html =>
	h.div(
		[h.Class("space-y-6 p-4")],
		[
			...(entry.metricDescription
				? [h.p([h.Class("text-sm text-muted-foreground")], [entry.metricDescription])]
				: []),
			chartSection(h, model, entry, bounds, clockMs),
			breakdownSection(h, model, entry),
		],
	)
