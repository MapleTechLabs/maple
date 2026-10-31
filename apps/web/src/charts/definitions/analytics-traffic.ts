import { ANALYTICS_METRICS, findMetric } from "../../components/analytics/metrics"
import { bucketDate, makeBucketAxis } from "@maple/ui/components/plot/bucket-axis"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import { areaY, d3Curve, defineChart, lineY, type ChartPoint, type ChartValue } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { verticalGradient } from "./fixed-metric-axes"
import { cursorTooltip, tooltipFocusCapture } from "./plot-constants"

// The analytics traffic chart's definition. Colours arrive resolved in the spec; series arrive in paint order.

type TrafficSpec = Extract<ChartSpec, { readonly _tag: "AnalyticsTraffic" }>
type SeriesKey = "primary" | "companion"

interface TrafficPoint {
	readonly bucket: string
	readonly date: Date
	readonly primary?: number | null
	readonly companion?: number | null
}

/** The descriptor a spec names by key; an unknown key reads as the strip's first metric. */
const metricOf = (key: string) => ANALYTICS_METRICS.find((metric) => metric.key === key) ?? findMetric("visitors")

export const buildAnalyticsTraffic = (
	spec: TrafficSpec,
): BuiltChart<TrafficPoint, ChartValue, number> => {
	const data: ReadonlyArray<TrafficPoint> = spec.points.map((point) => ({ ...point, date: bucketDate(point.bucket) }))
	const axis = makeBucketAxis(
		data.map((point) => point.bucket),
		spec.timeZone,
	)
	const chrome = { border: spec.colors["border"] ?? "", background: spec.colors["background"] ?? "" }
	const colorOf = (key: SeriesKey) => spec.colors[key] ?? chrome.border
	const at = (point: TrafficPoint) => point.date
	const valueOf = (key: SeriesKey) => (point: TrafficPoint) => {
		const value = point[key]
		return typeof value === "number" ? value : null
	}
	const curve = d3Curve(curveMonotoneX)
	const tickMetric = metricOf(spec.tickMetric)
	const focus = tooltipFocusCapture()
	const definition = defineChart({
		gradients: spec.series.map((entry) =>
			verticalGradient(`${spec.gradientPrefix}-${entry.key}`, colorOf(entry.key)),
		),
		marks: [
			...spec.series.flatMap((entry) => [
				areaY(data, {
					id: `${entry.key}-band`,
					x: at,
					y: valueOf(entry.key),
					y1: () => 0,
					fill: `url(#${spec.gradientPrefix}-${entry.key})`,
					fillOpacity: 1,
					stroke: "none",
					curve,
				}),
				lineY(data, {
					id: entry.key,
					x: at,
					y: valueOf(entry.key),
					stroke: colorOf(entry.key),
					strokeWidth: 1.5,
					curve,
				}),
			]),
			...spec.series.map((entry) => focusDot(data, at, valueOf(entry.key), colorOf(entry.key), chrome)),
			focusCrosshair(chrome),
		],
		scales: {
			x: axis.x,
			y: {
				grid: DASHED_Y_GRID,
				scale: scaleLinear,
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 8,
						format: (value: number) => (value === 0 ? "0" : tickMetric.format(value)),
					},
				},
			},
		},
		margin: { left: spec.isNarrow ? 36 : 52, right: 8, top: 4 },
		focus: "group-x",
		focusRing: false,
		tooltip: cursorTooltip<TrafficPoint>(focus.anchor),
	})
	const tooltipOf = (points: ReadonlyArray<ChartPoint<TrafficPoint, ChartValue, number>>) =>
		Option.map(Option.fromNullishOr(points[0]), ({ datum }) => {
			const highlighted = focus.highlight(
				spec.series.map((entry): readonly [string, number | null] => [
					metricOf(entry.metric).label,
					valueOf(entry.key)(datum),
				]),
			)
			const base = {
				heading: axis.heading(datum.bucket),
				rows: spec.series.flatMap((entry) => {
					const value = valueOf(entry.key)(datum)
					const metric = metricOf(entry.metric)
					return value === null
						? []
						: [{ label: metric.label, color: colorOf(entry.key), dashed: false, value: metric.format(value) }]
				}),
			}
			return highlighted === undefined ? ChartTooltip.Bucket(base) : ChartTooltip.Bucket({ ...base, highlighted })
		})
	return { definition, focusKeyOf: (point) => point.datum.bucket, tooltipOf }
}
