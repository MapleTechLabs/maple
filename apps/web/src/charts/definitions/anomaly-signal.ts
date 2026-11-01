import { bucketDate, makeBucketAxis } from "@maple/ui/components/plot/bucket-axis"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { formatSignalValue } from "@maple/web-data/anomalies/format"
import { areaY, type ChartValue, d3Curve, defineChart, lineY, rect, ruleY, text } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { SERIES_STROKE_WIDTH, verticalGradient } from "./fixed-metric-axes"
import { cursorTooltip, tooltipFocusCapture } from "./plot-constants"

// The anomaly timeseries chart's definition. `thresholdRules` is copied below because
// threshold-rules.ts reads the theme through a React module; colours arrive resolved.

type AnomalySignalSpec = Extract<ChartSpec, { readonly _tag: "AnomalySignal" }>
type SignalPoint = Readonly<{ bucket: string; value: number }>
type Threshold = Readonly<{ value: number; color: string; label: string }>

// copied: threshold-rules.ts constants.
const THRESHOLD_STROKE_WIDTH = 1.5
const THRESHOLD_LABEL_FONT_SIZE = 10
const THRESHOLD_LABEL_DX = -4
const THRESHOLD_LABEL_DY = -6

/** `thresholdRules` with resolved colours: one dashed `ruleY`, labels anchored at `labelX`. */
const thresholdRules = (thresholds: ReadonlyArray<Threshold>, labelX: Date | undefined) => {
	const valid = thresholds.filter((threshold) => Number.isFinite(threshold.value))
	if (valid.length === 0) return []
	const rules = ruleY(valid, {
		y: (threshold: Threshold) => threshold.value,
		stroke: (threshold: Threshold) => threshold.color,
		strokeOpacity: 1,
		strokeWidth: THRESHOLD_STROKE_WIDTH,
		strokeDasharray: "4 4",
	})
	if (labelX === undefined) return [rules]
	return [
		rules,
		decorative(
			text(valid, {
				x: () => labelX,
				y: (threshold: Threshold) => threshold.value,
				text: (threshold: Threshold) => threshold.label,
				fill: (threshold: Threshold) => threshold.color,
				anchor: "end",
				dx: THRESHOLD_LABEL_DX,
				dy: THRESHOLD_LABEL_DY,
				fontSize: THRESHOLD_LABEL_FONT_SIZE,
			}),
		),
	]
}

/** The points that parse, oldest first: what the chart draws (empty means the empty message). */
export const sortedSignal = (points: ReadonlyArray<SignalPoint>): ReadonlyArray<SignalPoint> =>
	points.toSorted((a, b) => toEpochMs(a.bucket) - toEpochMs(b.bucket))

export const buildAnomalySignal = (spec: AnomalySignalSpec): BuiltChart<SignalPoint, ChartValue, number> => {
	const color = (key: string) => spec.colors[key] ?? spec.colors.border ?? ""
	const stroke = color("stroke")
	const chrome = { border: color("border"), background: color("background") }
	const valueFormatter = (value: number) =>
		formatSignalValue(spec.signalType, Number.isFinite(value) ? value : 0)
	const data = sortedSignal(spec.points)
	const axis = makeBucketAxis(
		data.map((point) => point.bucket),
		spec.timeZone,
	)

	// Snap the incident window to actual bucket values so the shading lines up with the points.
	const startMs = toEpochMs(spec.firstTriggeredAt)
	const endMs = spec.resolvedAt !== null ? toEpochMs(spec.resolvedAt) : Infinity
	const x1 =
		data.find((point) => toEpochMs(point.bucket) >= startMs)?.bucket ?? data[data.length - 1]?.bucket
	const x2Raw = data.findLast((point) => toEpochMs(point.bucket) <= endMs)?.bucket
	const x2 = x2Raw === undefined || x1 === undefined || toEpochMs(x2Raw) < toEpochMs(x1) ? x1 : x2Raw
	const window = x1 === undefined || x2 === undefined ? null : { x1: bucketDate(x1), x2: bucketDate(x2) }

	const maxVal = data.reduce(
		(max, point) => Math.max(max, point.value),
		Math.max(spec.thresholdValue, spec.baselineMedian),
	)
	const yDomain: [number, number] = [0, maxVal * 1.15]
	const at = (point: SignalPoint) => bucketDate(point.bucket)
	const value = (point: SignalPoint) => point.value
	const focus = tooltipFocusCapture()

	return {
		definition: defineChart({
			gradients: [verticalGradient(spec.gradientId, stroke)],
			marks: [
				...(window
					? [
							decorative(
								rect([window], {
									x1: (w: { x1: Date; x2: Date }) => w.x1,
									x2: (w: { x1: Date; x2: Date }) => w.x2,
									y1: () => yDomain[0],
									y2: () => yDomain[1],
									fill: stroke,
									fillOpacity: 0.06,
									stroke: "none",
								}),
							),
						]
					: []),
				...thresholdRules(
					[
						{ value: spec.baselineMedian, color: color("muted"), label: "Baseline" },
						{ value: spec.thresholdValue, color: color("threshold"), label: "Threshold" },
					],
					axis.domainMs ? new Date(axis.domainMs[1]) : undefined,
				),
				areaY(data, {
					x: at,
					y: value,
					y1: () => yDomain[0],
					fill: `url(#${spec.gradientId})`,
					fillOpacity: 1,
					stroke: "none",
					curve: d3Curve(curveMonotoneX),
				}),
				lineY(data, {
					x: at,
					y: value,
					stroke,
					strokeWidth: SERIES_STROKE_WIDTH,
					curve: d3Curve(curveMonotoneX),
				}),
				focusDot(data, at, value, stroke, chrome),
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
							format: (value: number) => (value === 0 ? "0" : valueFormatter(value)),
						},
					},
				},
			},
			margin: { top: 8, right: 8, left: 70 },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focus.anchor),
		}),
		focusKeyOf: (point) => point.datum.bucket,
		tooltipOf: (points) =>
			Option.map(Option.fromNullishOr(points[0]), ({ datum }) =>
				ChartTooltip.Bucket({
					heading: axis.heading(datum.bucket),
					rows: [
						{
							label: "Observed",
							color: stroke,
							dashed: false,
							value: valueFormatter(datum.value),
						},
					],
				}),
			),
	}
}
