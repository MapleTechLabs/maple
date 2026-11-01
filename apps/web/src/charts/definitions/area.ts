import { formatBucketLabel, formatValueByUnit } from "@maple/ui/lib/format"
import { isolatedPointIndexes, pointsFit } from "@maple/ui/components/charts/_shared/sparse-series"
import {
	findFirstPartialIndex,
	splitAtFirstPartial,
	trimEmptyTrailingBuckets,
} from "@maple/ui/components/plot/partial-buckets"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { areaY, d3Curve, defineChart, dot, lineY, type ChartValue } from "@tanstack/charts"
import { curveMonotoneX } from "d3-shape"
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
import { asFiniteNumber, type TimeseriesRow } from "../timeseries-rows"
import { timeseriesXAxis } from "@maple/ui/components/plot/timeseries-axis"
import type { BuiltChart } from "./built-chart"
import {
	AREA_FILL_END,
	AREA_FILL_PARTIAL,
	roundCapDasharray,
	SERIES_STROKE_WIDTH,
	verticalGradient,
} from "./fixed-metric-axes"
import { cursorTooltip, UNBOUNDED_FOCUS_DISTANCE } from "./plot-constants"

// Port of `QueryBuilderAreaChart` and `QueryBuilderLineChart` (packages/ui/src/components/charts/area/,
// line/), definition half: bands or lines, stacked or not, linear or monotone.
// TODO(thresholds): threshold rules, log scale and fitted or soft y bounds are not ported.

type AreaSpec = Extract<ChartSpec, { readonly _tag: "QueryBuilderArea" }>

const STROKE_WIDTH = SERIES_STROKE_WIDTH
const STACKED_STROKE_WIDTH = 1
const STACKED_FILL_OPACITY = 0.55
const PARTIAL_STACKED_FILL_OPACITY = 0.2
const PARTIAL_FILL_GRADIENT = [AREA_FILL_PARTIAL, AREA_FILL_END] as const

interface Series {
	readonly key: string
	readonly label: string
	readonly color: string
}

/** `computeStackBases`: per row object, where each visible band starts. */
const stackBases = (
	rows: ReadonlyArray<TimeseriesRow>,
	visible: ReadonlyArray<Series>,
): ReadonlyMap<TimeseriesRow, Readonly<Record<string, number>>> =>
	new Map(
		rows.map((row) => {
			const perKey = Object.fromEntries(
				visible.map((entry, index) => [
					entry.key,
					visible
						.slice(0, index)
						.reduce((total, below) => total + asFiniteNumber(row[below.key]), 0),
				]),
			)
			return [row, perKey]
		}),
	)

export const buildQueryBuilderArea = (spec: AreaSpec): BuiltChart<TimeseriesRow, ChartValue, number> => {
	const isLine = spec.mark === "line"
	const isStacked = !isLine && spec.stacked === true
	const { definitions } = seriesDefinitionsOf(spec.data)
	const unit = spec.unit ?? undefined
	const keys = definitions.map((definition) => definition.chartKey)
	const normalised = normaliseRows(spec.data, definitions)
	const rows = scaleRates(normalised, keys, unit, bucketSecondsOf(normalised))
	const visible: ReadonlyArray<Series> = definitions
		.filter((definition) => !spec.hidden.includes(definition.chartKey))
		.map((definition) => ({
			key: definition.chartKey,
			label: definition.rawKey,
			color: spec.colors[definition.chartKey] ?? spec.fallbackColor,
		}))
	const visibleKeys = visible.map((entry) => entry.key)
	const axisContext = axisContextOf(rows, spec.timeZone ?? undefined)
	const chrome = spec.chrome

	const first = findFirstPartialIndex(rows, { now: spec.nowMs })
	const plotRows = first === -1 ? rows : trimEmptyTrailingBuckets(rows, visibleKeys, first)
	const axis = spec.axis
	const yAxis = timeseriesYAxis({
		rows: plotRows,
		visibleKeys,
		unit,
		stacked: isStacked,
		...(axis === undefined
			? undefined
			: {
					logScale: axis.logScale,
					fitYAxisToData: axis.fitYAxisToData,
					...(axis.softMin === null ? undefined : { softMin: axis.softMin }),
					...(axis.softMax === null ? undefined : { softMax: axis.softMax }),
					thresholds: axis.thresholds,
				}),
	})
	const yDomainFloor = yAxis.domain[0]
	const bases = isStacked ? stackBases(plotRows, visible) : null
	const baseOf = (row: TimeseriesRow, key: string) => Math.max(yDomainFloor, bases?.get(row)?.[key] ?? 0)
	const topOf = (row: TimeseriesRow, key: string) =>
		isLine
			? asFiniteNumber(row[key])
			: Math.max(yDomainFloor, (bases?.get(row)?.[key] ?? 0) + asFiniteNumber(row[key]))

	const dotIndexes: ReadonlyMap<string, ReadonlySet<number>> = spec.showPoints === false
		? new Map()
		: spec.showPoints === true || pointsFit(spec.containerWidth, plotRows.length)
			? new Map(visibleKeys.map((key) => [key, new Set(plotRows.map((_, index) => index))]))
			: isolatedPointIndexes(plotRows, visibleKeys)

	const { solid, dashed } = splitAtFirstPartial(plotRows, visibleKeys, { now: spec.nowMs })
	const curve = spec.curve === "monotone" ? d3Curve(curveMonotoneX) : undefined
	const partialDash = roundCapDasharray(4, 4, isStacked ? STACKED_STROKE_WIDTH : STROKE_WIDTH)
	const gradientIdFor = (key: string, partial: boolean) =>
		`${spec.gradientPrefix}-${key}${partial ? "-partial" : ""}`
	const hasDashed = dashed.length > 0
	const fillOpacityFor = (partial: boolean) =>
		isStacked ? (partial ? PARTIAL_STACKED_FILL_OPACITY : STACKED_FILL_OPACITY) : 1

	const band = (rowSlice: ReadonlyArray<TimeseriesRow>, entry: Series, partial: boolean) =>
		areaY(rowSlice, {
			id: partial ? `${entry.key}-partial-area` : `${entry.key}-area`,
			x: (row: TimeseriesRow) => row.date,
			y: (row: TimeseriesRow) => topOf(row, entry.key),
			y1: (row: TimeseriesRow) => baseOf(row, entry.key),
			fill: isStacked ? entry.color : `url(#${gradientIdFor(entry.key, partial)})`,
			fillOpacity: fillOpacityFor(partial),
			stroke: "none",
			curve,
		})

	const edge = (rowSlice: ReadonlyArray<TimeseriesRow>, entry: Series, partial: boolean) =>
		lineY(rowSlice, {
			id: partial ? `${entry.key}-partial` : entry.key,
			x: (row: TimeseriesRow) => row.date,
			y: (row: TimeseriesRow) => topOf(row, entry.key),
			stroke: entry.color,
			strokeWidth: isStacked ? STACKED_STROKE_WIDTH : STROKE_WIDTH,
			curve,
			strokeDasharray: partial ? partialDash : undefined,
		})

	const gradients =
		isLine || isStacked
			? []
			: [
					...visible.map((entry) => verticalGradient(gradientIdFor(entry.key, false), entry.color)),
					...(hasDashed
						? visible.map((entry) =>
								verticalGradient(
									gradientIdFor(entry.key, true),
									entry.color,
									...PARTIAL_FILL_GRADIENT,
								),
							)
						: []),
				]

	const paths = isLine
		? [
				...visible.map((entry) => edge(solid, entry, false)),
				...(hasDashed ? visible.map((entry) => edge(dashed, entry, true)) : []),
			]
		: [
				...visible.map((entry) => band(solid, entry, false)),
				...(hasDashed ? visible.map((entry) => band(dashed, entry, true)) : []),
				...(isStacked ? [] : visible.map((entry) => edge(solid, entry, false))),
				...(hasDashed ? visible.map((entry) => edge(dashed, entry, true)) : []),
			]

	const definition = defineChart({
		gradients,
		marks: [
			...thresholdMarks(axis?.thresholds ?? [], plotRows.at(-1)?.date),
			...paths,
			...visible.flatMap((entry) => {
				const indexes = dotIndexes.get(entry.key)
				if (!indexes || indexes.size === 0) return []
				const points = solid.filter((_, index) => indexes.has(index))
				return [
					dot(points, {
						x: (row: TimeseriesRow) => row.date,
						y: (row: TimeseriesRow) => topOf(row, entry.key),
						r: 2.5,
						fill: entry.color,
					}),
				]
			}),
			...visible.map((entry) =>
				focusDot(
					plotRows,
					(row: TimeseriesRow) => row.date,
					(row: TimeseriesRow) => topOf(row, entry.key),
					entry.color,
					chrome,
				),
			),
			focusCrosshair(chrome),
		],
		scales: { x: timeseriesXAxis(axisContext), y: yAxis.y },
		focus: "group-x",
		...(isLine ? undefined : { maxFocusDistance: UNBOUNDED_FOCUS_DISTANCE }),
		focusRing: false,
		tooltip: spec.showTooltip ? cursorTooltip<TimeseriesRow>("pointer") : false,
	})

	return {
		definition,
		focusKeyOf: (point) => point.datum.bucket,
		tooltipOf: (points) =>
			Option.map(Option.fromNullishOr(points[0]?.datum), (datum) =>
				ChartTooltip.Bucket({
					heading: formatBucketLabel(datum.bucket, axisContext, "tooltip"),
					rows: visible.map((entry) => ({
						label: entry.label,
						color: entry.color,
						dashed: false,
						value: formatValueByUnit(asFiniteNumber(datum[entry.key]), unit),
					})),
				}),
			),
	}
}
