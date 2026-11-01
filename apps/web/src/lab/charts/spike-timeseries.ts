import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { muteColor } from "@maple/ui/components/plot/color-scale"
import { formatBucketLabel, formatLatency, formatNumber } from "@maple/ui/lib/format"
import {
	errorThroughput,
	splitAtFirstPartial,
	timeseriesAxisContext,
	TIMESERIES_PARTIAL_ROWS,
	TIMESERIES_SPIKE_ROWS,
	type TimeseriesSpikeRow,
} from "./timeseries-data"
import { areaY, type ChartPoint, type ChartValue, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scaleTime } from "d3-scale"
import { Option } from "effect"
import { ChartTooltip } from "../../charts/chart-spec"
import type { BuiltChart } from "../../charts/definitions/built-chart"
import {
	AREA_FILL_END,
	roundCapDasharray,
	verticalGradient,
} from "../../charts/definitions/fixed-metric-axes"
import {
	cursorTooltip,
	MUTED_COLOR_AMOUNT,
	tooltipFocusCapture,
} from "../../charts/definitions/plot-constants"
import { type SpikeSpec, mutedOf, MUTED_OPACITY } from "./spike-spec"

// `LineSpike` / `LineLegendSpike` and `AreaSpike` / `AreaLegendSpike`, definition half.

type Point = ChartPoint<TimeseriesSpikeRow, ChartValue, number>

const STROKE_WIDTH = 2.5
const INCOMPLETE_DASHARRAY = roundCapDasharray(4.5, 7, STROKE_WIDTH)
const FADED_START_OPACITY = 0.15
const FADED_END_OPACITY = AREA_FILL_END

interface Series {
	readonly id: string
	readonly label: string
	readonly color: string
	readonly value: (row: TimeseriesSpikeRow) => number
}

const color = (spec: SpikeSpec, token: string): string => spec.colors[token] ?? ""

export const latencySeries = (spec: SpikeSpec): ReadonlyArray<Series> => [
	{ id: "p99", label: "P99", color: color(spec, "--chart-p99"), value: (row) => row.p99LatencyMs },
	{ id: "p95", label: "P95", color: color(spec, "--chart-p95"), value: (row) => row.p95LatencyMs },
	{ id: "p50", label: "P50", color: color(spec, "--chart-p50"), value: (row) => row.p50LatencyMs },
]

export const throughputSeries = (spec: SpikeSpec): ReadonlyArray<Series> => [
	{
		id: "throughput",
		label: "Throughput",
		color: color(spec, "--chart-throughput"),
		value: (row) => row.throughput,
	},
	{ id: "errors", label: "Errors", color: color(spec, "--chart-error"), value: errorThroughput },
]

const chromeOf = (spec: SpikeSpec) => ({
	border: color(spec, "--border"),
	background: color(spec, "--background"),
})

const xScale = (axisContext: ReturnType<typeof timeseriesAxisContext>) => ({
	scale: scaleTime,
	axis: {
		line: false,
		ticks: {
			size: 0,
			padding: 8,
			spacing: 72,
			format: (value: Date) => formatBucketLabel(value.toISOString(), axisContext, "tick"),
		},
	},
})

/** `PlotTooltipBody` reduced to data, emphasising the series nearest the cursor. */
const tooltipOf =
	(
		series: ReadonlyArray<Series>,
		axisContext: ReturnType<typeof timeseriesAxisContext>,
		format: (value: number) => string,
		highlight: (plotted: ReadonlyArray<readonly [string, number | null]>) => string | undefined,
	) =>
	(points: ReadonlyArray<Point>): Option.Option<ChartTooltip> =>
		Option.map(Option.fromNullishOr(points[0]), ({ datum }) => {
			const highlighted = highlight(series.map((entry) => [entry.label, entry.value(datum)] as const))
			return ChartTooltip.Bucket({
				heading: `${formatBucketLabel(datum.bucket, axisContext, "tooltip")}${datum.partial ? " · partial" : ""}`,
				...(highlighted === undefined ? undefined : { highlighted }),
				rows: series.map((entry) => ({
					label: entry.label,
					color: entry.color,
					dashed: false,
					value: format(entry.value(datum)),
				})),
			})
		})

const rowsOf = (spec: SpikeSpec): ReadonlyArray<TimeseriesSpikeRow> =>
	spec.arm.includes("incomplete") ? TIMESERIES_PARTIAL_ROWS : TIMESERIES_SPIKE_ROWS

const splitOf = (spec: SpikeSpec, rows: ReadonlyArray<TimeseriesSpikeRow>) =>
	spec.arm.includes("incomplete") ? splitAtFirstPartial(rows) : { solid: rows, dashed: [] }

/** The y domain over every series, muted ones included: emphasis never moves the axis. */
const dataMaxOf = (rows: ReadonlyArray<TimeseriesSpikeRow>, series: ReadonlyArray<Series>): number =>
	rows.reduce(
		(max, row) => series.reduce((seriesMax, entry) => Math.max(seriesMax, entry.value(row)), max),
		0,
	)

/** `LineFigure`. */
export const buildLineSpike = (spec: SpikeSpec): BuiltChart<TimeseriesSpikeRow, ChartValue, number> => {
	const rows = rowsOf(spec)
	const series = latencySeries(spec)
	const muted = mutedOf(
		spec,
		series.map((entry) => entry.id),
	)
	const chrome = chromeOf(spec)
	const axisContext = timeseriesAxisContext(rows)
	const focus = tooltipFocusCapture()
	const { solid, dashed } = splitOf(spec, rows)
	const opacityFor = (id: string) => (muted.has(id) ? MUTED_OPACITY : 1)
	const line = (data: ReadonlyArray<TimeseriesSpikeRow>, entry: Series, isDashed: boolean) =>
		lineY(data, {
			id: isDashed ? `${entry.id}Incomplete` : entry.id,
			x: (d: TimeseriesSpikeRow) => d.date,
			y: entry.value,
			stroke: entry.color,
			strokeWidth: STROKE_WIDTH,
			strokeOpacity: opacityFor(entry.id),
			...(isDashed ? { strokeDasharray: INCOMPLETE_DASHARRAY } : undefined),
		})
	const definition = defineChart({
		marks: [
			...series.map((entry) => line(solid, entry, false)),
			...series.map((entry) => line(dashed, entry, true)),
			...series.map((entry) =>
				focusDot(
					rows,
					(d: TimeseriesSpikeRow) => d.date,
					entry.value,
					muted.has(entry.id)
						? muteColor(entry.color, chrome.background, MUTED_COLOR_AMOUNT)
						: entry.color,
					chrome,
				),
			),
			focusCrosshair(chrome),
		],
		scales: {
			x: xScale(axisContext),
			y: {
				scale: scaleLinear().domain([0, dataMaxOf(rows, series)]),
				nice: true,
				grid: true,
				axis: {
					line: false,
					ticks: { size: 0, padding: 6, format: (value: number) => formatLatency(value) },
				},
			},
		},
		focus: "group-x",
		focusRing: false,
		tooltip: cursorTooltip(focus.anchor),
	})
	return {
		definition,
		focusKeyOf: (point) => point.datum.bucket,
		tooltipOf: tooltipOf(series, axisContext, formatLatency, focus.highlight),
	}
}

/** `AreaFigure`. */
export const buildAreaSpike = (spec: SpikeSpec): BuiltChart<TimeseriesSpikeRow, ChartValue, number> => {
	const rows = rowsOf(spec)
	const series = throughputSeries(spec)
	const muted = mutedOf(
		spec,
		series.map((entry) => entry.id),
	)
	const chrome = chromeOf(spec)
	const axisContext = timeseriesAxisContext(rows)
	const focus = tooltipFocusCapture()
	const { solid, dashed } = splitOf(spec, rows)
	const idPrefix = `areaSpike-${spec.arm}-`
	const opacityFor = (id: string) => (muted.has(id) ? MUTED_OPACITY : 1)
	const x = (d: TimeseriesSpikeRow) => d.date
	const definition = defineChart({
		gradients: series.flatMap((entry) => [
			verticalGradient(`${idPrefix}${entry.id}`, entry.color),
			verticalGradient(
				`${idPrefix}${entry.id}Faded`,
				entry.color,
				FADED_START_OPACITY,
				FADED_END_OPACITY,
			),
		]),
		marks: [
			...series.flatMap((entry) => [
				areaY(solid, {
					id: `${entry.id}Area`,
					x,
					y: entry.value,
					fill: `url(#${idPrefix}${entry.id})`,
					stroke: "none",
					fillOpacity: opacityFor(entry.id),
				}),
				areaY(dashed, {
					id: `${entry.id}AreaIncomplete`,
					x,
					y: entry.value,
					fill: `url(#${idPrefix}${entry.id}Faded)`,
					stroke: "none",
					fillOpacity: opacityFor(entry.id),
				}),
				lineY(solid, {
					id: `${entry.id}Line`,
					x,
					y: entry.value,
					stroke: entry.color,
					strokeWidth: STROKE_WIDTH,
					strokeOpacity: opacityFor(entry.id),
				}),
				lineY(dashed, {
					id: `${entry.id}LineIncomplete`,
					x,
					y: entry.value,
					stroke: entry.color,
					strokeWidth: STROKE_WIDTH,
					strokeOpacity: opacityFor(entry.id),
					strokeDasharray: INCOMPLETE_DASHARRAY,
				}),
			]),
			...series.map((entry) =>
				focusDot(
					rows,
					x,
					entry.value,
					muted.has(entry.id)
						? muteColor(entry.color, chrome.background, MUTED_COLOR_AMOUNT)
						: entry.color,
					chrome,
				),
			),
			focusCrosshair(chrome),
		],
		scales: {
			x: xScale(axisContext),
			y: {
				scale: scaleLinear().domain([0, dataMaxOf(rows, series)]),
				nice: true,
				grid: true,
				axis: { line: false, ticks: { size: 0, padding: 6, format: formatNumber } },
			},
		},
		focus: "group-x",
		focusRing: false,
		tooltip: cursorTooltip(focus.anchor),
	})
	return {
		definition,
		focusKeyOf: (point) => point.datum.bucket,
		tooltipOf: tooltipOf(series, axisContext, formatNumber, focus.highlight),
	}
}
