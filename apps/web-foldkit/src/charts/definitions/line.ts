import { formatBucketLabel, formatValueByUnit } from "@maple/ui/lib/format"
import { isolatedPointIndexes, pointsFit } from "@maple/ui/components/charts/_shared/sparse-series"
import {
	findFirstPartialIndex,
	splitAtFirstPartial,
	trimEmptyTrailingBuckets,
} from "@maple/ui/components/plot/partial-buckets"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { timeseriesXAxis } from "@maple/ui/components/plot/timeseries-axis"
import { defineChart, dot, lineY, type ChartValue } from "@tanstack/charts"
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
import type { BuiltChart } from "./built-chart"
import { cursorTooltip } from "./plot-constants"

// Port of `QueryBuilderLineChart` (packages/ui/src/components/charts/line/query-builder-line-chart.tsx),
// definition half: one line per series, the in-flight tail dashed, dots where they fit.
// TODO(line): monotone curves, thresholds, log scale, soft bounds and `showPoints` are not ported.

type LineSpec = Extract<ChartSpec, { readonly _tag: "QueryBuilderLine" }>

const STROKE_WIDTH = 2

// copied: `roundCapDasharray` (plot-paint.ts imports React's `useId`).
const roundCapDasharray = (on: number, off: number, strokeWidth: number): string =>
	`${Math.max(0.01, on - strokeWidth)} ${off + strokeWidth}`

interface Series {
	readonly key: string
	readonly label: string
	readonly color: string
}

export const buildQueryBuilderLine = (spec: LineSpec): BuiltChart<TimeseriesRow, ChartValue, number> => {
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
	const plotRows = first === -1 ? rows : trimEmptyTrailingBuckets(rows, visibleKeys, first)
	const dotIndexes: ReadonlyMap<string, ReadonlySet<number>> = pointsFit(
		spec.containerWidth,
		plotRows.length,
	)
		? new Map(visibleKeys.map((key) => [key, new Set(plotRows.map((_, index) => index))]))
		: isolatedPointIndexes(plotRows, visibleKeys)
	const { solid, dashed } = splitAtFirstPartial(plotRows, visibleKeys, { now: spec.nowMs })
	const partialDash = roundCapDasharray(4, 4, STROKE_WIDTH)
	const valueOf = (key: string) => (row: TimeseriesRow) => asFiniteNumber(row[key])

	const line = (rowSlice: ReadonlyArray<TimeseriesRow>, entry: Series, dash: boolean) =>
		lineY(rowSlice, {
			id: dash ? `${entry.key}-partial` : entry.key,
			x: (row: TimeseriesRow) => row.date,
			y: valueOf(entry.key),
			stroke: entry.color,
			strokeWidth: STROKE_WIDTH,
			strokeDasharray: dash ? partialDash : undefined,
		})

	const definition = defineChart({
		marks: [
			...visible.map((entry) => line(solid, entry, false)),
			...(dashed.length > 0 ? visible.map((entry) => line(dashed, entry, true)) : []),
			...visible.flatMap((entry) => {
				const indexes = dotIndexes.get(entry.key)
				if (!indexes || indexes.size === 0) return []
				const points = solid.filter((_, index) => indexes.has(index))
				return [
					dot(points, {
						x: (row: TimeseriesRow) => row.date,
						y: valueOf(entry.key),
						r: 2.5,
						fill: entry.color,
					}),
				]
			}),
			...visible.map((entry) =>
				focusDot(
					plotRows,
					(row: TimeseriesRow) => row.date,
					valueOf(entry.key),
					entry.color,
					spec.chrome,
				),
			),
			focusCrosshair(spec.chrome),
		],
		scales: {
			x: timeseriesXAxis(axisContext),
			y: timeseriesYAxis({ rows: plotRows, visibleKeys, unit }).y,
		},
		focus: "group-x",
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
