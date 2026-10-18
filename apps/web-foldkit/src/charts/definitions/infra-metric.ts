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
import { formatBytes } from "@maple/ui/lib/format"
import { curveMonotoneX } from "d3-shape"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import {
	formatValueWithUnit,
	type InfraPoint,
	transformRows,
	UNNAMED_SERIES_KEY,
} from "../infra-metric-series"
import type { BuiltChart } from "./built-chart"
import { verticalGradient } from "./fixed-metric-axes"
import { chartEventMarkerMarks, placeMarkersInWindow } from "./event-markers"
import { cursorTooltip } from "./plot-constants"

// Port of `InfraMetricChart`'s definition (apps/web/src/components/infra/primitives/infra-metric-chart.tsx).

type InfraMetricSpec = Extract<ChartSpec, { readonly _tag: "InfraMetric" }>

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

/** The pivoted rows, with silent buckets of a shared domain added when the chart shows gaps. */
const pointsOf = (spec: InfraMetricSpec) => {
	const transformed = transformRows(spec.rows)
	if (!spec.gaps || spec.xDomain === null) return transformed
	const reported = new Set(transformed.data.map((point) => point.bucket))
	const silent = spec.xDomain
		.filter((bucket) => !reported.has(bucket))
		.map((bucket): InfraPoint => ({ bucket, date: bucketDate(bucket) }))
	return {
		series: transformed.series,
		data: [...transformed.data, ...silent].toSorted((a, b) => a.bucket.localeCompare(b.bucket)),
	}
}

const tickFormatter =
	(unit: InfraMetricSpec["unit"]) =>
	(value: number): string =>
		unit === "cores"
			? value.toLocaleString(
					undefined,
					Math.abs(value) < 0.1 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 },
				)
			: unit === "bytes_per_second"
				? formatBytes(value)
				: formatValueWithUnit(value, unit)

export const buildInfraMetric = (spec: InfraMetricSpec): BuiltChart<InfraDatum, ChartValue, number> => {
	const { data, series } = pointsOf(spec)
	const axis = makeBucketAxis(spec.xDomain ?? data.map((point) => point.bucket), spec.timeZone)
	const thresholds = spec.showThreshold && spec.unit === "percent" ? [{ value: THRESHOLD_FRACTION }] : []
	const yDomain = niceLinearDomain(
		linearYDomain({ rows: data, keys: series, stacked: spec.stacked, thresholds }),
	)
	const chrome = { border: spec.colors.border ?? "", background: spec.colors.background ?? "" }
	const colorOf = (name: string) => spec.colors[name] ?? chrome.border
	const at = (point: InfraPoint) => point.date
	const valueOf = (name: string) => (point: InfraPoint) => {
		const value = point[name]
		return typeof value === "number" ? value : null
	}
	const gradientFor = (name: string) => `${spec.gradientPrefix}-${name.replace(/\W+/g, "_")}`
	const curve = d3Curve(curveMonotoneX)
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
	const thresholdColor = spec.colors.threshold ?? ""
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
				axis: { line: false, ticks: { size: 0, padding: 8, format: tickFormatter(spec.unit) } },
			},
		},
		margin: { top: 12, right: 12, left: 56 },
		focus: "group-x",
		focusRing: false,
		tooltip: cursorTooltip<InfraDatum>("pointer"),
	})
	const labelFor = (name: string) => (name === UNNAMED_SERIES_KEY ? (spec.seriesLabel ?? name) : name)
	const tooltipOf = (points: ReadonlyArray<ChartPoint<InfraDatum, ChartValue, number>>) =>
		Option.map(Option.fromNullishOr(points[0]), ({ datum }) => {
			const row = rowOf(datum)
			return ChartTooltip.Bucket({
				heading: axis.heading(row.bucket),
				rows: series.flatMap((name) => {
					const value = row[name]
					return typeof value === "number"
						? [
								{
									label: labelFor(name),
									color: colorOf(name),
									dashed: false,
									value: formatValueWithUnit(value, spec.unit),
								},
							]
						: []
				}),
			})
		})
	return { definition, focusKeyOf: (point) => rowOf(point.datum).bucket, tooltipOf }
}
