import { formatBucketLabel, formatValueByUnit } from "@maple/ui/lib/format"
import { findFirstPartialIndex, trimEmptyTrailingBuckets } from "@maple/ui/components/plot/partial-buckets"
import { bucketTimeScale, minBarLength } from "@maple/ui/components/plot/plot-scales"
import { timeseriesXAxis } from "@maple/ui/components/plot/timeseries-axis"
import { barY, type ChartValue, defineChart, group } from "@tanstack/charts"
import { Option } from "effect"
import { thresholdMarks } from "./threshold-marks"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import {
	axisContextOf,
	bucketSecondsOf,
	normaliseRows,
	scaleRates,
	seriesDefinitionsOf,
	timeseriesYAxis,
} from "../timeseries"
import { asFiniteNumber, type TimeseriesAxisContext, type TimeseriesRow } from "../timeseries-rows"
import type { BuiltChart } from "./built-chart"
import { cursorTooltip, UNBOUNDED_FOCUS_DISTANCE } from "./plot-constants"

// Port of `QueryBuilderBarChart` (packages/ui/src/components/charts/bar/query-builder-bar-chart.tsx),
// definition half: bars centred on their bucket on a time scale padded by half a bucket, closed and
// in-flight lanes, the hovered column kept bright.
// TODO(bar-thresholds): thresholds, log scale, soft bounds and the "Other" bucketing past
// `MAX_BAR_SERIES` are not ported.

type BarSpec = Extract<ChartSpec, { readonly _tag: "QueryBuilderBar" }>

/** Matches the Recharts `maxBarSize={48}`. */
const MAX_BAR_THICKNESS = 48
const BAR_RADIUS = 2
const PARTIAL_FILL_OPACITY = 0.45
const DIMMED_FILL_OPACITY = 0.3
const DIMMED_PARTIAL_FILL_OPACITY = 0.15

/** One bar: a bucket, a series, and the value where the two meet. */
interface BarCell {
	readonly row: TimeseriesRow
	readonly key: string
	readonly color: string
	readonly value: number
	/** The running total beneath it in a stack; 0 otherwise. */
	readonly base: number
	readonly partial: boolean
}

// copied: `bucketBandDomain` and `timeseriesBandXAxis` (plot/timeseries.tsx, a React module).
const bucketBandDomain = (
	rows: ReadonlyArray<TimeseriesRow>,
	bucketSeconds: number | undefined,
): [Date, Date] | null => {
	const times = rows.map((row) => row.date.getTime()).filter((time) => Number.isFinite(time))
	if (rows.length < 2 || times.length === 0) return null
	const min = Math.min(...times)
	const max = Math.max(...times)
	const gaps = times.slice(1).flatMap((time, index) => (time > times[index] ? [time - times[index]] : []))
	const smallestGap = gaps.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...gaps)
	if (min === max) return null
	const interval =
		bucketSeconds != null && bucketSeconds > 0
			? bucketSeconds * 1000
			: Number.isFinite(smallestGap)
				? smallestGap
				: 0
	if (interval <= 0) return null
	return [new Date(min - interval / 2), new Date(max + interval / 2)]
}

const timeseriesBandXAxis = (axisContext: TimeseriesAxisContext, rows: ReadonlyArray<TimeseriesRow>) => {
	const domain = bucketBandDomain(rows, axisContext.bucketSeconds)
	if (domain === null) return timeseriesXAxis(axisContext)
	return { ...timeseriesXAxis(axisContext), scale: bucketTimeScale(domain, axisContext.timeZone) }
}

interface Series {
	readonly key: string
	readonly label: string
	readonly color: string
}

/** The cells of every visible series per bucket, in `visible` order (the stack is bottom-up). */
const cellsOf = (
	rows: ReadonlyArray<TimeseriesRow>,
	visible: ReadonlyArray<Series>,
	first: number,
	stacked: boolean,
): ReadonlyArray<BarCell> =>
	rows.flatMap((row, index) => {
		const partial = first !== -1 && index >= first
		return visible.map((entry, entryIndex) => ({
			row,
			key: entry.key,
			color: entry.color,
			value: asFiniteNumber(row[entry.key]),
			base: stacked
				? visible.slice(0, entryIndex).reduce((sum, below) => sum + asFiniteNumber(row[below.key]), 0)
				: 0,
			partial,
		}))
	})

export const buildQueryBuilderBar = (spec: BarSpec): BuiltChart<BarCell, ChartValue, number> => {
	const { definitions } = seriesDefinitionsOf(spec.data)
	const unit = spec.unit ?? undefined
	const keys = definitions.map((definition) => definition.chartKey)
	const normalised = normaliseRows(spec.data, definitions)
	const rows = scaleRates(normalised, keys, unit, bucketSecondsOf(normalised))
	const visible: ReadonlyArray<Series> = definitions.map((definition) => ({
		key: definition.chartKey,
		label: definition.rawKey,
		color: spec.colors[definition.chartKey] ?? spec.fallbackColor,
	}))
	const visibleKeys = visible.map((entry) => entry.key)
	const axisContext = axisContextOf(rows, spec.timeZone ?? undefined)
	const first = findFirstPartialIndex(rows, { now: spec.nowMs })
	// A trailing in-flight bucket with nothing in it is dropped: it is not a reading of zero.
	const plotRows = first === -1 ? rows : trimEmptyTrailingBuckets(rows, visibleKeys, first)
	const cells = cellsOf(plotRows, visible, first, spec.stacked)
	const axis = spec.axis
	// `fitYAxisToData` is deliberately not forwarded: a bar's value is its area from the baseline.
	const yAxis = timeseriesYAxis({
		rows: plotRows,
		visibleKeys,
		unit,
		stacked: spec.stacked,
		...(axis === undefined
			? undefined
			: {
					logScale: axis.logScale,
					...(axis.softMin === null ? undefined : { softMin: axis.softMin }),
					...(axis.softMax === null ? undefined : { softMax: axis.softMax }),
					thresholds: axis.thresholds,
				}),
	})
	const floor = yAxis.domain[0]
	const floored = (value: number) => Math.max(floor, value)
	const lift = minBarLength(yAxis.domain)
	const liftBar = (value: number) => (spec.stacked ? value : (lift(value) ?? value))

	// Both lanes see every cell (the other lane's come back null), so both infer one bandwidth.
	const lane = (partialLane: boolean) =>
		barY(cells, {
			id: partialLane ? "bars-partial" : "bars",
			x: (cell: BarCell) => cell.row.date,
			y: (cell: BarCell) => (cell.partial === partialLane ? cell.value : null),
			y1: (cell: BarCell) => floored(cell.base),
			y2: (cell: BarCell) =>
				cell.partial === partialLane ? floored(cell.base + liftBar(cell.value)) : null,
			z: (cell: BarCell) => cell.key,
			fill: (cell: BarCell) => cell.color,
			fillOpacity: partialLane ? PARTIAL_FILL_OPACITY : undefined,
			maxThickness: MAX_BAR_THICKNESS,
			radius: spec.stacked ? 0 : BAR_RADIUS,
			layout: spec.stacked ? undefined : group(),
			states: [
				{
					when: (context: { matches: (match: "x") => boolean }) => !context.matches("x"),
					style: { fillOpacity: partialLane ? DIMMED_PARTIAL_FILL_OPACITY : DIMMED_FILL_OPACITY },
				},
			],
		})

	const definition = defineChart({
		marks: [
			...thresholdMarks(
				axis?.thresholds ?? [],
				bucketBandDomain(plotRows, axisContext.bucketSeconds)?.[1] ?? plotRows.at(-1)?.date,
			),
			lane(false),
			lane(true),
		],
		scales: { x: timeseriesBandXAxis(axisContext, plotRows), y: yAxis.y },
		focus: "group-x",
		maxFocusDistance: UNBOUNDED_FOCUS_DISTANCE,
		focusRing: false,
		tooltip: spec.showTooltip ? cursorTooltip<BarCell>("pointer") : false,
	})

	return {
		definition,
		focusKeyOf: (point) => point.datum.row.bucket,
		tooltipOf: (points) =>
			Option.map(Option.fromNullishOr(points[0]?.datum.row), (row) =>
				ChartTooltip.Bucket({
					heading: formatBucketLabel(row.bucket, axisContext, "tooltip"),
					rows: visible.map((entry) => ({
						label: entry.label,
						color: entry.color,
						dashed: false,
						value: formatValueByUnit(asFiniteNumber(row[entry.key]), unit),
					})),
				}),
			),
	}
}
