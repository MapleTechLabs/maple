import { formatBucketLabel, formatValueByUnit } from "@maple/ui/lib/format"
import { isolatedPointIndexes, pointsFit } from "@maple/ui/components/charts/_shared/sparse-series"
import {
	findFirstPartialIndex,
	splitAtFirstPartial,
	trimEmptyTrailingBuckets,
} from "@maple/ui/components/plot/partial-buckets"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { areaY, defineChart, dot, lineY, type ChartLinearGradient, type ChartValue } from "@tanstack/charts"
import { Option } from "effect"
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
import { cursorTooltip, UNBOUNDED_FOCUS_DISTANCE } from "./plot-constants"

// Port of `QueryBuilderAreaChart` (packages/ui/src/components/charts/area/query-builder-area-chart.tsx),
// definition half, for the unstacked, linear, threshold-free chart the metric explorer draws.
// TODO(stacked): stacked bands, monotone curves, thresholds and hidden series are not ported.

type AreaSpec = Extract<ChartSpec, { readonly _tag: "QueryBuilderArea" }>

const STROKE_WIDTH = 2
const AREA_FILL_OPACITY = 0.6
const FILL_GRADIENT = [0.8, 0.1] as const
const PARTIAL_FILL_GRADIENT = [0.15, 0] as const

// copied: `verticalGradient` and `roundCapDasharray` (plot-paint.ts imports React's `useId`).
const verticalGradient = (
	id: string,
	color: string,
	startOpacity: number,
	endOpacity: number,
): ChartLinearGradient => ({
	id,
	x1: 0,
	y1: 0,
	x2: 0,
	y2: 1,
	stops: [
		{ offset: 0.05, color, opacity: startOpacity },
		{ offset: 0.95, color, opacity: endOpacity },
	],
})

const roundCapDasharray = (on: number, off: number, strokeWidth: number): string =>
	`${Math.max(0.01, on - strokeWidth)} ${off + strokeWidth}`

interface Series {
	readonly key: string
	readonly label: string
	readonly color: string
}

export const buildQueryBuilderArea = (spec: AreaSpec): BuiltChart<TimeseriesRow, ChartValue, number> => {
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
	const yAxis = timeseriesYAxis({ rows: plotRows, visibleKeys, unit })
	const yDomainFloor = yAxis.domain[0]
	const baseOf = () => Math.max(yDomainFloor, 0)
	const topOf = (row: TimeseriesRow, key: string) => Math.max(yDomainFloor, asFiniteNumber(row[key]))

	const dotIndexes: ReadonlyMap<string, ReadonlySet<number>> = pointsFit(
		spec.containerWidth,
		plotRows.length,
	)
		? new Map(visibleKeys.map((key) => [key, new Set(plotRows.map((_, index) => index))]))
		: isolatedPointIndexes(plotRows, visibleKeys)

	const { solid, dashed } = splitAtFirstPartial(plotRows, visibleKeys, { now: spec.nowMs })
	const partialDash = roundCapDasharray(4, 4, STROKE_WIDTH)
	const gradientIdFor = (key: string, partial: boolean) =>
		`${spec.gradientPrefix}-${key}${partial ? "-partial" : ""}`
	const hasDashed = dashed.length > 0

	const band = (rowSlice: ReadonlyArray<TimeseriesRow>, entry: Series, partial: boolean) =>
		areaY(rowSlice, {
			id: partial ? `${entry.key}-partial-area` : `${entry.key}-area`,
			x: (row: TimeseriesRow) => row.date,
			y: (row: TimeseriesRow) => topOf(row, entry.key),
			y1: () => baseOf(),
			fill: `url(#${gradientIdFor(entry.key, partial)})`,
			fillOpacity: AREA_FILL_OPACITY,
			stroke: "none",
		})

	const edge = (rowSlice: ReadonlyArray<TimeseriesRow>, entry: Series, partial: boolean) =>
		lineY(rowSlice, {
			id: partial ? `${entry.key}-partial` : entry.key,
			x: (row: TimeseriesRow) => row.date,
			y: (row: TimeseriesRow) => topOf(row, entry.key),
			stroke: entry.color,
			strokeWidth: STROKE_WIDTH,
			strokeDasharray: partial ? partialDash : undefined,
		})

	const definition = defineChart({
		gradients: [
			...visible.map((entry) =>
				verticalGradient(gradientIdFor(entry.key, false), entry.color, ...FILL_GRADIENT),
			),
			...(hasDashed
				? visible.map((entry) =>
						verticalGradient(
							gradientIdFor(entry.key, true),
							entry.color,
							...PARTIAL_FILL_GRADIENT,
						),
					)
				: []),
		],
		marks: [
			...visible.map((entry) => band(solid, entry, false)),
			...(hasDashed ? visible.map((entry) => band(dashed, entry, true)) : []),
			...visible.map((entry) => edge(solid, entry, false)),
			...(hasDashed ? visible.map((entry) => edge(dashed, entry, true)) : []),
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
		maxFocusDistance: UNBOUNDED_FOCUS_DISTANCE,
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
