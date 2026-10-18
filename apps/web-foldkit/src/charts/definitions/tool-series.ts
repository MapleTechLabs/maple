import { bucketDate, makeBucketAxis } from "@maple/ui/components/plot/bucket-axis"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import { linearYDomain, niceLinearDomain } from "@maple/ui/components/plot/plot-scales"
import { formatToolMetric } from "@maple/web-data/lib/tool-analytics"
import { type ChartValue, d3Curve, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { cursorTooltip, UNBOUNDED_FOCUS_DISTANCE } from "./plot-constants"

// Port of `ToolSeriesChart`'s definition memo and `seriesLines` (agent-sessions/tools/
// tool-series-chart.tsx, tool-chart-marks.ts). TODO(tooltip-anchor): legacy anchors the card on the
// cursor plot's focus store; here it follows the pointer.

type ToolSeriesSpec = Extract<ChartSpec, { readonly _tag: "ToolSeries" }>
type Row = ToolSeriesSpec["rows"][number]

/** A series at a bucket: one vertex of a line. */
interface Cell {
	readonly row: Row
	readonly key: string
}

const LINE_WIDTH = 1.5

const valueAt = (row: Row, key: string): number | null => {
	const value = row[key]
	return typeof value === "number" ? value : null
}

const bucketOf = (row: Row): string => {
	const value = row["bucket"]
	return typeof value === "string" ? value : ""
}

export const buildToolSeries = (spec: ToolSeriesSpec): BuiltChart<Cell, ChartValue, number> => {
	const axis = makeBucketAxis(spec.rows.map(bucketOf), spec.timeZone)
	const yDomain = niceLinearDomain(
		linearYDomain({ rows: spec.rows, keys: spec.series.map((entry) => entry.key) }),
	)
	const at = (cell: Cell) => bucketDate(bucketOf(cell.row))
	const valueOf = (cell: Cell) => valueAt(cell.row, cell.key)
	const marks = spec.series.flatMap((entry) => {
		const cells = spec.rows.map((row) => ({ row, key: entry.key }))
		return [
			lineY(cells, {
				id: entry.key,
				x: at,
				y: valueOf,
				stroke: entry.color,
				strokeWidth: LINE_WIDTH,
				curve: d3Curve(curveMonotoneX),
			}),
			focusDot(cells, at, valueOf, entry.color, spec.chrome),
		]
	})
	return {
		definition: defineChart({
			marks: [...marks, focusCrosshair(spec.chrome)],
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
							format: (value: number) => (value === 0 ? "0" : formatToolMetric(value, spec.metric)),
						},
					},
				},
			},
			margin: { right: 8, top: 4 },
			focus: "group-x",
			maxFocusDistance: UNBOUNDED_FOCUS_DISTANCE,
			focusRing: false,
			tooltip: cursorTooltip("pointer"),
		}),
		focusKeyOf: (point) => bucketOf(point.datum.row),
		tooltipOf: (points) =>
			Option.map(Option.fromNullishOr(points[0]), ({ datum }) =>
				ChartTooltip.Bucket({
					heading: axis.heading(bucketOf(datum.row)),
					rows: spec.series.flatMap((entry) => {
						const value = valueAt(datum.row, entry.key)
						return value === null
							? []
							: [
									{
										label: entry.label,
										color: entry.color,
										dashed: false,
										value: formatToolMetric(value, spec.metric),
									},
								]
					}),
				}),
			),
	}
}
