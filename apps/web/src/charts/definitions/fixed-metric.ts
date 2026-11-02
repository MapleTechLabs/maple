import { areaY, d3Curve, defineChart, dot, lineY, type ChartPoint, type ChartValue } from "@tanstack/charts"
import { curveMonotoneX } from "d3-shape"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { splitAtFirstPartial } from "@maple/ui/components/plot/partial-buckets"
import { dropNullPoints, loneReading } from "@maple/ui/components/plot/series-gaps"
import { formatBucketLabel, formatErrorRate, formatLatency, formatThroughput } from "@maple/ui/lib/format"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import {
	ERROR_KEY,
	type FixedMetricModel,
	fixedMetricModel,
	LATENCY_SERIES,
	THROUGHPUT_KEY,
	throughputPlot,
	TRACED_KEY,
} from "../fixed-metric-series"
import { pinnedTimeXAxis } from "@maple/ui/components/plot/bucket-axis"
import { timeseriesXAxis } from "@maple/ui/components/plot/timeseries-axis"
import { timeseriesYAxis } from "../timeseries"
import { asFiniteNumber, type TimeseriesRow } from "../timeseries-rows"
import type { BuiltChart } from "./built-chart"
import { AREA_FILL_END, AREA_FILL_PARTIAL, roundCapDasharray, SERIES_STROKE_WIDTH, verticalGradient } from "./fixed-metric-axes"
import { cursorTooltip, tooltipFocusCapture } from "./plot-constants"

// Ports of `ThroughputAreaChart`, `ErrorRateAreaChart` and `LatencyLineChart`
// (packages/ui/src/components/charts/{area,line}), definition half. Code copied, constants unchanged.

type FixedMetricSpec = Extract<ChartSpec, { readonly _tag: "FixedMetric" }>
type Point = ChartPoint<TimeseriesRow, ChartValue, number>

/** `PlotTooltipSeries`: one tooltip row reader. */
interface TooltipSeries {
	readonly label: string
	readonly color: string
	readonly dashed?: boolean
	readonly value: (row: TimeseriesRow) => number | null
	readonly format: (value: number) => string
}

const STROKE_WIDTH = SERIES_STROKE_WIDTH
/** Monotone like every other time-series chart: it smooths without overshooting a bucket. */
const curve = d3Curve(curveMonotoneX)
const at = (row: TimeseriesRow) => row.date
const valueOf = (key: string) => (row: TimeseriesRow) => asFiniteNumber(row[key])
/** A missing value stays null, so the line bridges it and the focus dot skips it instead of dropping to 0. */
const gapValueOf = (key: string) => (row: TimeseriesRow) =>
	row[key] == null ? null : asFiniteNumber(row[key])
const read = (key: string) => (row: TimeseriesRow) => {
	const value = row[key]
	return typeof value === "number" ? value : null
}

const colorOf = (spec: FixedMetricSpec, key: string): string => spec.colors[key] ?? ""
/** `margin: yAxisWidth == null ? undefined : { left: yAxisWidth }`, plus an optional right lock. */
const marginOf = (spec: FixedMetricSpec) =>
	spec.marginLeft === undefined && spec.marginRight === undefined
		? undefined
		: {
				...(spec.marginLeft === undefined ? undefined : { left: spec.marginLeft }),
				...(spec.marginRight === undefined ? undefined : { right: spec.marginRight }),
			}
/** The x axis: pinned to the spec's window when it sets one, else over the drawn rows. */
const xAxisOf = (spec: FixedMetricSpec, model: FixedMetricModel) =>
	spec.xDomainMs === undefined
		? timeseriesXAxis(model.axisContext)
		: pinnedTimeXAxis(model.axisContext, spec.xDomainMs)
const chromeOf = (spec: FixedMetricSpec) => ({
	border: colorOf(spec, "border"),
	background: colorOf(spec, "background"),
})

/** `PlotTooltipBody` reduced to data: rows off `points[0].datum`, nulls skipped. */
const bucketTooltip =
	(
		model: FixedMetricModel,
		series: ReadonlyArray<TooltipSeries>,
		focus: ReturnType<typeof tooltipFocusCapture>,
	) =>
	(points: ReadonlyArray<Point>): Option.Option<ChartTooltip> =>
		Option.map(Option.fromNullishOr(points[0]), ({ datum }) => {
			// `resolveTooltipHighlight`: the series nearest the cursor is emphasised.
			const highlighted = focus.highlight(
				series.map((entry) => [entry.label, entry.value(datum)] as const),
			)
			const base = {
				heading: formatBucketLabel(datum.bucket, model.axisContext, "tooltip"),
				rows: series.flatMap((entry) => {
					const value = entry.value(datum)
					return value == null
						? []
						: [
								{
									label: entry.label,
									color: entry.color,
									dashed: entry.dashed ?? false,
									value: entry.format(value),
								},
							]
				}),
			}
			return highlighted === undefined
				? ChartTooltip.Bucket(base)
				: ChartTooltip.Bucket({ ...base, highlighted })
		})

const throughputChart = (spec: FixedMetricSpec): BuiltChart<TimeseriesRow, ChartValue, number> => {
	const model = fixedMetricModel(spec.rows, spec.timeZone, spec.nowMs)
	const focus = tooltipFocusCapture()
	const plot = throughputPlot(model, spec.perSecond)
	const { rows, rateLabel, hasSampling, hasErrors, hasTraced } = plot
	const throughputColor = colorOf(spec, "throughput")
	const errorColor = colorOf(spec, "error")
	const chrome = chromeOf(spec)
	const { solid, dashed } = splitAtFirstPartial(rows, [THROUGHPUT_KEY], model.trimOptions)
	const hasDashed = dashed.length > 0
	const gradientId = `${spec.gradientPrefix}-fill`
	const fadedGradientId = `${spec.gradientPrefix}-fill-partial`
	const partialDash = roundCapDasharray(4, 4, STROKE_WIDTH)
	const errorDash = roundCapDasharray(3, 3, 1.5)
	const tracedDash = roundCapDasharray(4, 4, 1)

	const band = (slice: ReadonlyArray<TimeseriesRow>, fill: string, partial: boolean) =>
		areaY(slice, {
			id: partial ? "throughput-area-partial" : "throughput-area",
			x: at,
			y: valueOf(THROUGHPUT_KEY),
			y1: () => 0,
			fill: `url(#${fill})`,
			fillOpacity: 1,
			curve,
			stroke: "none",
		})
	const edge = (slice: ReadonlyArray<TimeseriesRow>, partial: boolean) =>
		lineY(slice, {
			curve,
			id: partial ? "throughput-partial" : "throughput",
			x: at,
			y: valueOf(THROUGHPUT_KEY),
			stroke: throughputColor,
			strokeWidth: STROKE_WIDTH,
			strokeDasharray: partial ? partialDash : undefined,
		})
	const errorLine = (slice: ReadonlyArray<TimeseriesRow>, partial: boolean) =>
		lineY(slice, {
			curve,
			id: partial ? "error-throughput-partial" : "error-throughput",
			x: at,
			y: valueOf(ERROR_KEY),
			stroke: errorColor,
			strokeWidth: 1.5,
			strokeDasharray: errorDash,
			strokeOpacity: partial ? 0.5 : undefined,
		})
	const tracedLine = lineY(rows, {
		curve,
		id: "traced-throughput",
		x: at,
		y: valueOf(TRACED_KEY),
		stroke: throughputColor,
		strokeWidth: 1,
		strokeDasharray: tracedDash,
		strokeOpacity: 0.5,
	})

	const definition = defineChart({
		margin: marginOf(spec),
		gradients: [
			verticalGradient(gradientId, throughputColor),
			...(hasDashed ? [verticalGradient(fadedGradientId, throughputColor, AREA_FILL_PARTIAL, AREA_FILL_END)] : []),
		],
		marks: [
			band(solid, gradientId, false),
			...(hasDashed ? [band(dashed, fadedGradientId, true)] : []),
			edge(solid, false),
			...(hasDashed ? [edge(dashed, true)] : []),
			...(hasErrors ? [errorLine(solid, false)] : []),
			...(hasErrors && hasDashed ? [errorLine(dashed, true)] : []),
			...(hasTraced ? [tracedLine] : []),
			focusDot(rows, at, valueOf(THROUGHPUT_KEY), throughputColor, chrome),
			...(hasErrors ? [focusDot(rows, at, valueOf(ERROR_KEY), errorColor, chrome)] : []),
			focusCrosshair(chrome),
		],
		scales: {
			x: xAxisOf(spec, model),
			y: timeseriesYAxis({
				rows,
				visibleKeys: [THROUGHPUT_KEY, ERROR_KEY, TRACED_KEY],
				format: (tick: number) => formatThroughput(tick, rateLabel),
			}).y,
		},
		focus: "group-x",
		focusRing: false,
		tooltip: spec.showTooltip ? cursorTooltip<TimeseriesRow>(focus.anchor) : false,
	})

	const withSuffix = (value: number) => formatThroughput(value, rateLabel)
	const tooltipSeries: ReadonlyArray<TooltipSeries> = [
		{
			label: hasSampling ? "Estimated" : "Throughput",
			color: throughputColor,
			value: read(THROUGHPUT_KEY),
			format: (value) => `${hasSampling ? "~" : ""}${withSuffix(value)}`,
		},
		...(hasErrors
			? [
					{
						label: "Errors",
						color: errorColor,
						dashed: true,
						value: (row: TimeseriesRow) => {
							const value = row[ERROR_KEY]
							return typeof value === "number" && value > 0 ? value : null
						},
						format: withSuffix,
					},
				]
			: []),
		...(hasTraced
			? [
					{
						label: "Traced",
						color: throughputColor,
						dashed: true,
						value: read(TRACED_KEY),
						format: withSuffix,
					},
				]
			: []),
	]
	return {
		definition,
		focusKeyOf: (point) => point.datum.bucket,
		tooltipOf: bucketTooltip(model, tooltipSeries, focus),
	}
}

/** `errorRateCeiling`: the worst bucket plus 20% headroom, never below 1% nor above 100%. */
const errorRateCeiling = (rows: ReadonlyArray<Record<string, unknown>>): number => {
	const dataMax = rows.reduce((max, row) => {
		const value = row.errorRate
		return typeof value === "number" && Number.isFinite(value) && value > max ? value : max
	}, 0)
	return Math.min(1, Math.max(dataMax * 1.2, 0.01))
}

const errorRateChart = (spec: FixedMetricSpec): BuiltChart<TimeseriesRow, ChartValue, number> => {
	const model = fixedMetricModel(spec.rows, spec.timeZone, spec.nowMs)
	const focus = tooltipFocusCapture()
	const { plotRows } = model
	const color = colorOf(spec, "errorRate")
	const chrome = chromeOf(spec)
	const { solid, dashed } = splitAtFirstPartial(plotRows, ["errorRate"], model.trimOptions)
	const partialDash = roundCapDasharray(4, 4, STROKE_WIDTH)
	const gradientId = `${spec.gradientPrefix}-fill`
	const fadedGradientId = `${spec.gradientPrefix}-fill-partial`
	const value = valueOf("errorRate")
	const band = (slice: ReadonlyArray<TimeseriesRow>, fill: string) =>
		areaY(slice, {
			id: fill === gradientId ? "error-rate-area" : "error-rate-area-partial",
			x: at,
			y: value,
			y1: () => 0,
			fill: `url(#${fill})`,
			fillOpacity: 1,
			curve,
			stroke: "none",
		})
	const edge = (slice: ReadonlyArray<TimeseriesRow>, partial: boolean) =>
		lineY(slice, {
			curve,
			id: partial ? "error-rate-partial" : "error-rate",
			x: at,
			y: value,
			stroke: color,
			strokeWidth: STROKE_WIDTH,
			strokeDasharray: partial ? partialDash : undefined,
		})
	const hasDashed = dashed.length > 0
	const definition = defineChart({
		margin: marginOf(spec),
		gradients: [
			verticalGradient(gradientId, color),
			...(hasDashed ? [verticalGradient(fadedGradientId, color, AREA_FILL_PARTIAL, AREA_FILL_END)] : []),
		],
		marks: [
			band(solid, gradientId),
			...(hasDashed ? [band(dashed, fadedGradientId)] : []),
			edge(solid, false),
			...(hasDashed ? [edge(dashed, true)] : []),
			focusDot(plotRows, at, value, color, chrome),
			focusCrosshair(chrome),
		],
		scales: {
			x: xAxisOf(spec, model),
			y: timeseriesYAxis({
				rows: plotRows,
				visibleKeys: ["errorRate"],
				softMin: 0,
				softMax: errorRateCeiling(plotRows),
				unit: "percent",
			}).y,
		},
		focus: "group-x",
		focusRing: false,
		tooltip: spec.showTooltip ? cursorTooltip<TimeseriesRow>(focus.anchor) : false,
	})
	const series = [{ label: "Error rate", color, value: read("errorRate"), format: formatErrorRate }]
	return {
		definition,
		focusKeyOf: (point) => point.datum.bucket,
		tooltipOf: bucketTooltip(model, series, focus),
	}
}

const latencyChart = (spec: FixedMetricSpec): BuiltChart<TimeseriesRow, ChartValue, number> => {
	const model = fixedMetricModel(spec.rows, spec.timeZone, spec.nowMs)
	const focus = tooltipFocusCapture()
	const { plotRows } = model
	const chrome = chromeOf(spec)
	const series = (spec.latencySeries ?? LATENCY_SERIES).map((entry) => ({
		...entry,
		color: colorOf(spec, entry.key),
	}))
	const keys = series.map((entry) => entry.key)
	const partialDash = roundCapDasharray(4, 4, STROKE_WIDTH)
	const line = (slice: ReadonlyArray<TimeseriesRow>, entry: (typeof series)[number], dash: boolean) =>
		lineY(slice, {
			curve,
			id: dash ? `${entry.key}-partial` : entry.key,
			x: at,
			y: gapValueOf(entry.key),
			stroke: entry.color,
			strokeWidth: STROKE_WIDTH,
			strokeDasharray: dash ? partialDash : undefined,
		})
	// Each series bridges the buckets it has no reading for, then splits, so the dashed tail
	// starts at that series' last closed reading.
	const lines = series.flatMap((entry) => {
		const readings = dropNullPoints(plotRows, gapValueOf(entry.key))
		const { solid, dashed } = splitAtFirstPartial(readings, [entry.key], model.trimOptions)
		return [line(solid, entry, false), ...(dashed.length > 0 ? [line(dashed, entry, true)] : [])]
	})
	const definition = defineChart({
		margin: marginOf(spec),
		marks: [
			...lines,
			...series.map((entry) =>
				dot(loneReading(plotRows, gapValueOf(entry.key)), {
					x: at,
					y: gapValueOf(entry.key),
					r: STROKE_WIDTH + 1,
					fill: entry.color,
				}),
			),
			...series.map((entry) => focusDot(plotRows, at, gapValueOf(entry.key), entry.color, chrome)),
			focusCrosshair(chrome),
		],
		scales: {
			x: xAxisOf(spec, model),
			y: timeseriesYAxis({ rows: plotRows, visibleKeys: keys, unit: "duration_ms" }).y,
		},
		focus: "group-x",
		focusRing: false,
		tooltip: spec.showTooltip ? cursorTooltip<TimeseriesRow>(focus.anchor) : false,
	})
	const tooltipSeries = series.map((entry) => ({
		label: entry.label,
		color: entry.color,
		value: read(entry.key),
		format: formatLatency,
	}))
	return {
		definition,
		focusKeyOf: (point) => point.datum.bucket,
		tooltipOf: bucketTooltip(model, tooltipSeries, focus),
	}
}

/** `ApdexAreaChart`: the band and its top edge on a `[0, 1]` axis, the in-flight tail dashed. */
const apdexChart = (spec: FixedMetricSpec): BuiltChart<TimeseriesRow, ChartValue, number> => {
	const model = fixedMetricModel(spec.rows, spec.timeZone, spec.nowMs)
	const focus = tooltipFocusCapture()
	const { plotRows } = model
	const color = colorOf(spec, "apdexScore")
	const chrome = chromeOf(spec)
	const { solid, dashed } = splitAtFirstPartial(plotRows, ["apdexScore"], model.trimOptions)
	const partialDash = roundCapDasharray(4, 4, STROKE_WIDTH)
	const gradientId = `${spec.gradientPrefix}-fill`
	const fadedGradientId = `${spec.gradientPrefix}-fill-partial`
	const value = valueOf("apdexScore")
	const band = (slice: ReadonlyArray<TimeseriesRow>, fill: string) =>
		areaY(slice, {
			id: fill === gradientId ? "apdex-area" : "apdex-area-partial",
			x: at,
			y: value,
			y1: () => 0,
			fill: `url(#${fill})`,
			fillOpacity: 1,
			curve,
			stroke: "none",
		})
	const edge = (slice: ReadonlyArray<TimeseriesRow>, partial: boolean) =>
		lineY(slice, {
			curve,
			id: partial ? "apdex-partial" : "apdex",
			x: at,
			y: value,
			stroke: color,
			strokeWidth: STROKE_WIDTH,
			strokeDasharray: partial ? partialDash : undefined,
		})
	const hasDashed = dashed.length > 0
	const definition = defineChart({
		margin: marginOf(spec),
		gradients: [
			verticalGradient(gradientId, color),
			...(hasDashed ? [verticalGradient(fadedGradientId, color, AREA_FILL_PARTIAL, AREA_FILL_END)] : []),
		],
		marks: [
			band(solid, gradientId),
			...(hasDashed ? [band(dashed, fadedGradientId)] : []),
			edge(solid, false),
			...(hasDashed ? [edge(dashed, true)] : []),
			focusDot(plotRows, at, value, color, chrome),
			focusCrosshair(chrome),
		],
		scales: {
			x: xAxisOf(spec, model),
			y: timeseriesYAxis({ rows: plotRows, visibleKeys: ["apdexScore"], softMin: 0, softMax: 1 }).y,
		},
		focus: "group-x",
		focusRing: false,
		tooltip: spec.showTooltip ? cursorTooltip<TimeseriesRow>(focus.anchor) : false,
	})
	const format = (score: number) => score.toFixed(2)
	const series = [{ label: "Apdex", color, value: read("apdexScore"), format }]
	return {
		definition,
		focusKeyOf: (point) => point.datum.bucket,
		tooltipOf: bucketTooltip(model, series, focus),
	}
}

export const buildFixedMetric = (spec: FixedMetricSpec): BuiltChart<TimeseriesRow, ChartValue, number> => {
	switch (spec.chart) {
		case "Apdex":
			return apdexChart(spec)
		case "Throughput":
			return throughputChart(spec)
		case "ErrorRate":
			return errorRateChart(spec)
		case "Latency":
			return latencyChart(spec)
	}
}
