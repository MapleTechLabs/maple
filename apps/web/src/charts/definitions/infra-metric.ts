import {
	type ChartUnit,
	formatValueWithUnit,
	type TransformedPoint,
	transformRows,
	UNNAMED_SERIES_KEY,
} from "../../components/infra/chart-units"
import {
	areaY,
	d3Curve,
	defineChart,
	dot,
	lineY,
	ruleY,
	stack,
	text,
	type ChartPoint,
	type ChartValue,
} from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { bucketDate, makeBucketAxis } from "@maple/ui/components/plot/bucket-axis"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import { linearYDomain, niceLinearDomain } from "@maple/ui/components/plot/plot-scales"
import { axisTickFormatter, axisTickValues, formatBytes } from "@maple/ui/lib/format"
import { curveMonotoneX } from "d3-shape"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { verticalGradient } from "./fixed-metric-axes"
import { chartEventMarkerMarks, placeMarkersInWindow } from "./event-markers"
import { cursorTooltip, tooltipFocusCapture } from "./plot-constants"

// The infra metric chart's definition. Colours arrive resolved in the spec.

type InfraMetricSpec = Extract<ChartSpec, { readonly _tag: "InfraMetric" }>
type InfraPoint = TransformedPoint

interface InfraCell {
	readonly point: InfraPoint
	readonly name: string
	readonly value: number | null
}

type InfraDatum = InfraPoint | InfraCell

const isCell = (datum: InfraDatum): datum is InfraCell => typeof datum.point === "object"
const rowOf = (datum: InfraDatum): InfraPoint => (isCell(datum) ? datum.point : datum)

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

/** The pivoted rows, with silent buckets of a shared domain added when the chart shows gaps. */
export const infraPoints = (spec: Pick<InfraMetricSpec, "rows" | "gaps" | "xDomain">) => {
	const transformed = transformRows(spec.rows, () => "")
	if (!spec.gaps || spec.xDomain === null) return transformed
	const reported = new Set(transformed.data.map((point) => point.bucket))
	const silent = spec.xDomain
		.filter((bucket) => !reported.has(bucket))
		.map((bucket): InfraPoint => ({ bucket, time: "", date: bucketDate(bucket) }))
	return {
		series: transformed.series,
		data: [...transformed.data, ...silent].toSorted((a, b) => a.bucket.localeCompare(b.bucket)),
	}
}

export const labelFor = (seriesLabel: string | null) => (name: string) =>
	name === UNNAMED_SERIES_KEY ? (seriesLabel ?? name) : name

/** Ticks on a short card: few enough that the axis never thins them. */
const Y_TICK_COUNT = 3

/** Latency and percent axes share one unit and precision across ticks; the rest format per value. */
const tickFormatter = (unit: InfraMetricSpec["unit"], domain: readonly [number, number]) =>
	unit === "milliseconds"
		? axisTickFormatter("duration_ms", domain, Y_TICK_COUNT, { max: Y_TICK_COUNT })
		: unit === "percent"
			? axisTickFormatter("percent", domain, Y_TICK_COUNT, { max: Y_TICK_COUNT })
			: valueTickFormatter(unit)

/** Explicit ticks where the precision comes from the step, so a 1s step reads "1s", not "1.0s". */
const tickValues = (unit: InfraMetricSpec["unit"], domain: readonly [number, number]) =>
	unit === "milliseconds" || unit === "percent"
		? axisTickValues(domain, Y_TICK_COUNT, { max: Y_TICK_COUNT })
		: undefined

/** Cores and load axes read "0.5, 1, 2"; the zero tick reads "0" on every unit. */
const valueTickFormatter =
	(unit: InfraMetricSpec["unit"]) =>
	(value: number): string =>
		value === 0
			? "0"
			: unit === "cores" || unit === "load"
				? value.toLocaleString(
						undefined,
						Math.abs(value) < 0.1
							? { maximumSignificantDigits: 2 }
							: { maximumFractionDigits: 2 },
					)
				: unit === "bytes_per_second"
					? formatBytes(value)
					: formatValueWithUnit(value, unit)

export const buildInfraMetric = (spec: InfraMetricSpec): BuiltChart<InfraDatum, ChartValue, number> => {
	const { data, series } = infraPoints(spec)
	const axis = makeBucketAxis(spec.xDomain ?? data.map((point) => point.bucket), spec.timeZone)
	const thresholds = spec.showThreshold && spec.unit === "percent" ? [{ value: THRESHOLD_FRACTION }] : []
	const niceDomain = niceLinearDomain(
		linearYDomain({ rows: data, keys: series, stacked: spec.stacked, thresholds }),
	)
	// A percent axis past 50% runs to 100%, so it draws "0, 50%, 100%" around the 80% line.
	// Stacked shares never pass 100%: a bucket whose parts sum higher is scaled down to fit.
	const isShare = spec.stacked && spec.unit === "percent"
	const yDomain: readonly [number, number] =
		isShare && niceDomain[1] > 1
			? [niceDomain[0], 1]
			: spec.unit === "percent" && niceDomain[1] > 0.5 && niceDomain[1] < 1
				? [niceDomain[0], 1]
				: niceDomain
	const chrome = spec.chrome
	const colorOf = (name: string) => spec.colors[name] ?? chrome.border
	const at = (point: InfraPoint) => point.date
	const valueOf = (name: string) => (point: InfraPoint) => {
		const value = point[name]
		return typeof value === "number" ? value : null
	}
	const gradientFor = (name: string) => `${spec.gradientPrefix}-${name.replace(/\W+/g, "_")}`
	const curve = d3Curve(curveMonotoneX)
	const shareScale = (point: InfraPoint) => {
		const sum = series.reduce((total, name) => total + (valueOf(name)(point) ?? 0), 0)
		return isShare && sum > 1 ? 1 / sum : 1
	}
	const cells: ReadonlyArray<InfraCell> = spec.stacked
		? data.flatMap((point) => {
				const scale = shareScale(point)
				return series.map((name) => {
					const value = valueOf(name)(point)
					return { point, name, value: value === null ? null : value * scale }
				})
			})
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
	const silent = (value: (point: InfraPoint) => number | null) => (point: InfraPoint | undefined) =>
		point === undefined || value(point) === null
	const lone = spec.gaps
		? series.map((name) => {
				const value = valueOf(name)
				return dot(
					data.filter(
						(point, index) =>
							value(point) !== null &&
							silent(value)(data[index - 1]) &&
							silent(value)(data[index + 1]),
					),
					{ x: at, y: value, r: STROKE_WIDTH + 1, fill: colorOf(name) },
				)
			})
		: []
	const thresholdColor = spec.thresholdColor
	const labelX = axis.domainMs ? new Date(axis.domainMs[1]) : undefined
	const thresholdMarks =
		thresholds.length === 0
			? []
			: [
					ruleY(thresholds, {
						y: (threshold: { value: number }) => threshold.value,
						stroke: thresholdColor,
						strokeOpacity: 1,
						strokeWidth: 1.5,
						strokeDasharray: "4 4",
					}),
					...(labelX === undefined
						? []
						: [
								decorative(
									text(thresholds, {
										x: () => labelX,
										y: (threshold: { value: number }) => threshold.value,
										text: () => "80%",
										fill: thresholdColor,
										anchor: "end",
										dx: -4,
										dy: -6,
										fontSize: 10,
									}),
								),
							]),
				]
	const placed = placeMarkersInWindow(spec.markers, spec.xDomain ?? data.map((point) => point.bucket))
	const focus = tooltipFocusCapture()
	const definition = defineChart({
		gradients: spec.stacked
			? series.map((name) => verticalGradient(gradientFor(name), colorOf(name), 0.45, 0.04))
			: [],
		marks: [
			...chartEventMarkerMarks(placed, yDomain, spec.markerColors),
			...thresholdMarks,
			...bands,
			...lone,
			...series.map((name) => focusDot(data, at, valueOf(name), colorOf(name), chrome)),
			focusCrosshair(chrome),
		],
		scales: {
			x: axis.x,
			y: {
				grid: DASHED_Y_GRID,
				scale: scaleLinear().domain(yDomain),
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 8,
						values: tickValues(spec.unit, yDomain),
						format: tickFormatter(spec.unit, yDomain),
					},
				},
			},
		},
		margin: { top: 12, right: 12, left: 56 },
		focus: "group-x",
		focusRing: false,
		tooltip: cursorTooltip<InfraDatum>(focus.anchor),
	})
	const label = labelFor(spec.seriesLabel)
	const tooltipOf = (points: ReadonlyArray<ChartPoint<InfraDatum, ChartValue, number>>) =>
		Option.map(Option.fromNullishOr(points[0]), ({ datum }) => {
			const row = rowOf(datum)
			// The raw value, stacked or not: the cursor series carry no stacked position.
			const highlighted = focus.highlight(
				series.map((name): readonly [string, number | null] => [label(name), valueOf(name)(row)]),
			)
			const base = {
				heading: axis.heading(row.bucket),
				rows: series.flatMap((name) => {
					const value = row[name]
					return typeof value === "number"
						? [
								{
									label: label(name),
									color: colorOf(name),
									dashed: false,
									value: formatValueWithUnit(value, spec.unit),
								},
							]
						: []
				}),
			}
			return highlighted === undefined
				? ChartTooltip.Bucket(base)
				: ChartTooltip.Bucket({ ...base, highlighted })
		})
	return { definition, focusKeyOf: (point) => rowOf(point.datum).bucket, tooltipOf }
}
