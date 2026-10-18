import {
	formatValueWithUnit,
	type ChartUnit,
	type TransformedPoint,
	transformRows,
	UNNAMED_SERIES_KEY,
} from "@maple/web/components/infra/chart-units"
import {
	areaY,
	type ChartValue,
	d3Curve,
	defineChart,
	dot,
	lineY,
	ruleY,
	stack,
	text,
} from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { bucketDate, makeBucketAxis } from "@maple/ui/components/plot/bucket-axis"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import { linearYDomain, niceLinearDomain } from "@maple/ui/components/plot/plot-scales"
import { formatBytes } from "@maple/ui/lib/format"
import { curveMonotoneX } from "d3-shape"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { verticalGradient } from "./fixed-metric-axes"
import { cursorTooltip } from "./plot-constants"

// Port of `InfraMetricChart`'s definition (apps/web/src/components/infra/primitives/infra-metric-chart.tsx),
// code copied, constants unchanged. Colours arrive resolved in the spec.

type InfraMetricSpec = Extract<ChartSpec, { readonly _tag: "InfraMetric" }>

interface InfraCell {
	readonly point: TransformedPoint
	readonly name: string
	readonly value: number | null
}
type InfraDatum = TransformedPoint | InfraCell

const isCell = (datum: InfraDatum): datum is InfraCell => typeof datum.point === "object"
const rowOf = (datum: InfraDatum): TransformedPoint => (isCell(datum) ? datum.point : datum)

const STROKE_WIDTH = 1.5
const THRESHOLD_FRACTION = 0.8
const UNITS: ReadonlyArray<ChartUnit> = [
	"percent",
	"cores",
	"seconds",
	"load",
	"bytes_per_second",
	"bytes",
	"milliseconds",
	"rate",
	"count",
]
export const asChartUnit = (unit: string): ChartUnit => UNITS.find((known) => known === unit) ?? "count"

/** The axis tick: the bare value where the unit would clip the 56px gutter. */
const tickFormatterFor =
	(unit: ChartUnit) =>
	(value: number): string =>
		unit === "cores"
			? value.toLocaleString(
					undefined,
					Math.abs(value) < 0.1 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 },
				)
			: unit === "bytes_per_second"
				? formatBytes(value)
				: formatValueWithUnit(value, unit)

/** The pivoted rows, with silent buckets of `xDomain` added as empty points when `gaps` is on. */
export const infraPoints = (spec: Pick<InfraMetricSpec, "rows" | "gaps" | "xDomain">) => {
	const transformed = transformRows(spec.rows, () => "")
	if (!spec.gaps || spec.xDomain === null) return transformed
	const reported = new Set(transformed.data.map((point) => point.bucket))
	const silent = spec.xDomain
		.filter((bucket) => !reported.has(bucket))
		.map((bucket): TransformedPoint => ({ bucket, time: "", date: bucketDate(bucket) }))
	return {
		series: transformed.series,
		data: [...transformed.data, ...silent].toSorted((a, b) => a.bucket.localeCompare(b.bucket)),
	}
}

export const labelFor = (seriesLabel: string | null) => (name: string) =>
	name === UNNAMED_SERIES_KEY ? (seriesLabel ?? name) : name

const valueOf = (name: string) => (point: TransformedPoint) => {
	const value = point[name]
	return typeof value === "number" ? value : null
}

/** `thresholdRules` (packages/ui/src/components/plot/threshold-rules.ts) with the colour resolved. */
const thresholdMarks = (value: number, color: string, labelX: Date | undefined) => {
	const thresholds = [{ value, label: "80%" }]
	const rules = ruleY(thresholds, {
		y: (threshold) => threshold.value,
		stroke: () => color,
		strokeOpacity: 1,
		strokeWidth: 1.5,
		strokeDasharray: "4 4",
	})
	if (labelX === undefined) return [rules]
	return [
		rules,
		decorative(
			text(thresholds, {
				x: () => labelX,
				y: (threshold) => threshold.value,
				text: (threshold) => threshold.label,
				fill: () => color,
				anchor: "end",
				dx: -4,
				dy: -6,
				fontSize: 10,
			}),
		),
	]
}

export const buildInfraMetric = (spec: InfraMetricSpec): BuiltChart<InfraDatum, ChartValue, number> => {
	const unit = asChartUnit(spec.unit)
	const { data, series } = infraPoints(spec)
	const axis = makeBucketAxis(spec.xDomain ?? data.map((point) => point.bucket), spec.timeZone)
	const label = labelFor(spec.seriesLabel)
	const hasThreshold = spec.showThreshold && unit === "percent"
	const yDomain = niceLinearDomain(
		linearYDomain({
			rows: data,
			keys: series,
			stacked: spec.stacked,
			thresholds: hasThreshold ? [{ value: THRESHOLD_FRACTION }] : [],
		}),
	)
	const colorOf = (name: string) => spec.colors[name] ?? spec.chrome.border
	const gradientFor = (name: string) => `${spec.gradientPrefix}-${name.replace(/\W+/g, "_")}`
	const curve = d3Curve(curveMonotoneX)
	const at = (point: TransformedPoint) => point.date

	const cells: ReadonlyArray<InfraCell> = spec.stacked
		? data.flatMap((point) => series.map((name) => ({ point, name, value: valueOf(name)(point) })))
		: []
	const bands = spec.stacked
		? [
				areaY(cells, {
					x: (cell: InfraCell) => cell.point.date,
					y: (cell: InfraCell) => cell.value,
					z: (cell: InfraCell) => cell.name,
					fill: (cell: InfraCell) => `url(#${gradientFor(cell.name)})`,
					stroke: (cell: InfraCell) => colorOf(cell.name),
					strokeWidth: STROKE_WIDTH,
					curve,
					layout: stack({ order: [...series] }),
				}),
			]
		: series.map((name) =>
				lineY(data, {
					id: name,
					x: at,
					y: valueOf(name),
					stroke: colorOf(name),
					strokeWidth: STROKE_WIDTH,
					curve,
				}),
			)
	const silent = (name: string) => (point: TransformedPoint | undefined) =>
		point === undefined || valueOf(name)(point) === null
	const lone = spec.gaps
		? series.map((name) =>
				dot(
					data.filter(
						(point, index) =>
							valueOf(name)(point) !== null &&
							silent(name)(data[index - 1]) &&
							silent(name)(data[index + 1]),
					),
					{ x: at, y: valueOf(name), r: STROKE_WIDTH + 1, fill: colorOf(name) },
				),
			)
		: []

	const definition = defineChart({
		gradients: spec.stacked
			? series.map((name) => verticalGradient(gradientFor(name), colorOf(name), 0.45, 0.04))
			: [],
		marks: [
			...(hasThreshold
				? thresholdMarks(
						THRESHOLD_FRACTION,
						spec.thresholdColor,
						axis.domainMs ? new Date(axis.domainMs[1]) : undefined,
					)
				: []),
			...bands,
			...lone,
			...series.map((name) => focusDot(data, at, valueOf(name), colorOf(name), spec.chrome)),
			focusCrosshair(spec.chrome),
		],
		scales: {
			x: axis.x,
			y: {
				grid: DASHED_Y_GRID,
				scale: scaleLinear().domain(yDomain),
				axis: { line: false, ticks: { size: 0, padding: 8, format: tickFormatterFor(unit) } },
			},
		},
		margin: { top: 12, right: 12, left: 56 },
		focus: "group-x",
		focusRing: false,
		tooltip: cursorTooltip<InfraDatum>("pointer"),
	})

	return {
		definition,
		focusKeyOf: (point) => rowOf(point.datum).bucket,
		tooltipOf: (points) =>
			Option.map(Option.fromNullishOr(points[0]?.datum), (datum) => {
				const row = rowOf(datum)
				return ChartTooltip.Bucket({
					heading: axis.heading(row.bucket),
					rows: series.flatMap((name) => {
						const value = valueOf(name)(row)
						return value === null
							? []
							: [
									{
										label: label(name),
										color: colorOf(name),
										dashed: false,
										value: formatValueWithUnit(value, unit),
									},
								]
					}),
				})
			}),
	}
}
