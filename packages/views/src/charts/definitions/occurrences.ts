import { Y_GRID } from "../plot/plot-grid"
import { integerTickValues, linearYDomain, minBarLength, niceLinearDomain } from "../plot/plot-scales"
import { formatNumber } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { barY, defineChart } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { Option, Order, Array as Arr } from "effect"
import { bucketDate, makeBucketAxis } from "../plot/bucket-axis"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { cursorTooltip } from "./plot-constants"
import { chartEventMarkerMarks, placeMarkersInWindow } from "./event-markers"

// The issue occurrence chart's definition: severity-coloured bars, one count per bucket on hover.

type OccurrencesSpec = Extract<ChartSpec, { readonly _tag: "Occurrences" }>
type Point = OccurrencesSpec["points"][number]

/** The points that parse, oldest first: what the chart draws (and empty means the empty message). */
export const sortedOccurrences = (points: ReadonlyArray<Point>): ReadonlyArray<Point> =>
	Arr.sort(
		Arr.filter(points, (point) => Number.isFinite(toEpochMs(point.bucket))),
		Order.mapInput(Order.Number, (point: Point) => toEpochMs(point.bucket)),
	)

/** The bars' x extent: each bar is centred on its bucket, so half a bucket past either end. */
const barExtentOf = (sorted: ReadonlyArray<Point>): { startMs: number; endMs: number } | undefined => {
	const times = Arr.map(sorted, (point) => toEpochMs(point.bucket))
	const first = times[0]
	const last = times[times.length - 1]
	const gaps = Arr.filter(
		Arr.zipWith(times.slice(1), times, (next, previous) => next - previous),
		(gap) => gap > 0,
	)
	const step = Math.min(...gaps)
	return first === undefined || last === undefined || !Number.isFinite(step)
		? undefined
		: { startMs: first - step / 2, endMs: last + step / 2 }
}

export const buildOccurrences = (spec: OccurrencesSpec): BuiltChart<Point, Date, number> => {
	const sorted = sortedOccurrences(spec.points)
	const axis = makeBucketAxis(
		Arr.map(sorted, (point) => point.bucket),
		spec.timeZone,
	)
	const yDomain = niceLinearDomain(linearYDomain({ rows: sorted, keys: ["count"] }))
	const liftCount = minBarLength(yDomain)
	const placed =
		spec.markerColors === undefined
			? []
			: placeMarkersInWindow(
					spec.markers ?? [],
					Arr.map(sorted, (point) => point.bucket),
					barExtentOf(sorted),
				)
	return {
		definition: defineChart({
			marks: [
				barY(sorted, {
					x: (point: Point) => bucketDate(point.bucket),
					y: (point: Point) => liftCount(point.count),
					fill: spec.color,
					radius: 2,
				}),
				...(spec.markerColors === undefined
					? []
					: chartEventMarkerMarks(placed, yDomain, spec.markerColors)),
			],
			scales: {
				x: axis.xBand,
				y: {
					grid: Y_GRID,
					scale: scaleLinear().domain(yDomain),
					axis: {
						line: false,
						ticks: {
							size: 0,
							padding: 4,
							values: integerTickValues(yDomain),
							format: (value: number) => formatNumber(value),
						},
					},
				},
			},
			// Room above the bars for a marker's label.
			margin: { top: placed.length === 0 ? 8 : 16, right: 4, bottom: 22, left: 44 },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip("pointer"),
		}),
		focusKeyOf: (point) => point.datum.bucket,
		tooltipOf: (points) =>
			Option.map(Option.fromNullishOr(points[0]), ({ datum }) =>
				ChartTooltip.Bucket({
					heading: axis.heading(datum.bucket),
					rows: [
						{
							label: "Occurrences",
							color: spec.color,
							dashed: false,
							value: datum.count.toLocaleString("en-US"),
						},
					],
				}),
			),
	}
}
