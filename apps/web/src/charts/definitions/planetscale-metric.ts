import { d3Curve, defineChart, dot, lineY, type ChartPoint, type ChartValue } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { bucketDate, makeBucketAxis } from "@maple/ui/components/plot/bucket-axis"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import { seriesRuns } from "@maple/ui/components/plot/series-gaps"
import { linearYDomain, niceLinearDomain } from "@maple/ui/components/plot/plot-scales"
import { curveMonotoneX } from "d3-shape"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { chartEventMarkerMarks, placeMarkersInWindow } from "./event-markers"
import { cursorTooltip } from "./plot-constants"
import { formatMetricValue, METRIC_LABELS, type PlanetScaleMetric } from "../planetscale-metric-series"

// The PlanetScale chart's definition.

type PlanetScaleSpec = Extract<ChartSpec, { readonly _tag: "PlanetScaleMetric" }>

interface MetricPoint {
	readonly bucket: string
	readonly date: Date
	readonly value: number | null
}

const isPercentMetric = (metric: PlanetScaleMetric) =>
	metric === "cpuMaxPercent" || metric === "memMaxPercent" || metric === "storageUsedPercent"

export const buildPlanetScaleMetric = (
	spec: PlanetScaleSpec,
): BuiltChart<MetricPoint, ChartValue, number> => {
	const data: ReadonlyArray<MetricPoint> = spec.points.map((point) => ({
		bucket: point.bucket,
		date: bucketDate(point.bucket),
		value: point.value,
	}))
	const buckets = spec.points.map((point) => point.bucket)
	const axis = makeBucketAxis(buckets, spec.timeZone)
	const placed = placeMarkersInWindow(spec.markers, buckets)
	const yDomain: [number, number] = isPercentMetric(spec.metric)
		? [0, 100]
		: niceLinearDomain(
				linearYDomain({ rows: data.map((point) => ({ value: point.value ?? 0 })), keys: ["value"] }),
			)
	const color = spec.colors[spec.metric] ?? spec.colors.border ?? ""
	const chrome = { border: spec.colors.border ?? "", background: spec.colors.background ?? "" }
	const at = (point: MetricPoint) => point.date
	const value = (point: MetricPoint) => point.value
	const { runs, lone } = seriesRuns(data, value, at)
	const definition = defineChart({
		marks: [
			...chartEventMarkerMarks(placed, yDomain, spec.markerColors),
			...runs.map((run, index) =>
				lineY(run, {
					id: `value:${index}`,
					x: at,
					y: value,
					stroke: color,
					strokeWidth: 1.5,
					curve: d3Curve(curveMonotoneX),
				}),
			),
			dot(lone, { x: at, y: value, r: 2.5, fill: color }),
			focusDot(data, at, value, color, chrome),
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
						format: (v: number) => (v === 0 ? "0" : formatMetricValue(v, spec.metric)),
					},
				},
			},
		},
		margin: { left: 52, top: 12, right: 12 },
		focus: "group-x",
		focusRing: false,
		tooltip: cursorTooltip<MetricPoint>("pointer"),
	})
	const tooltipOf = (points: ReadonlyArray<ChartPoint<MetricPoint, ChartValue, number>>) =>
		Option.map(Option.fromNullishOr(points[0]), ({ datum }) =>
			ChartTooltip.Bucket({
				heading: axis.heading(datum.bucket),
				rows:
					datum.value === null
						? []
						: [
								{
									label: METRIC_LABELS[spec.metric],
									color,
									dashed: false,
									value: formatMetricValue(datum.value, spec.metric),
								},
							],
			}),
		)
	return { definition, focusKeyOf: (point) => point.datum.bucket, tooltipOf }
}
