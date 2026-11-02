import { bucketDate, makeBucketAxis } from "@maple/ui/components/plot/bucket-axis"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import { dropNullPoints } from "@maple/ui/components/plot/series-gaps"
import { linearYDomain, niceLinearDomain } from "@maple/ui/components/plot/plot-scales"
import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { formatDurationNs, formatToolMetric } from "@maple/web-data/lib/tool-analytics"
import { type ChartValue, d3Curve, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"
import { Option } from "effect"
import { formatExactCount } from "../../page/kit/locale"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { cursorTooltip, UNBOUNDED_FOCUS_DISTANCE } from "./plot-constants"

// The agent tool series chart's definition and its series lines. TODO(tooltip-anchor): anchor the
// card on the cursor plot's focus store; it follows the pointer.

type ToolSeriesSpec = Extract<ChartSpec, { readonly _tag: "ToolSeries" }>
type ToolSeriesFormat = ToolSeriesSpec["format"]
type Row = ToolSeriesSpec["rows"][number]

/** A series at a bucket: one vertex of a line. */
interface Cell {
	readonly row: Row
	readonly key: string
}

const LINE_WIDTH = 1.5
/**
 * Candidate tick spacing wide enough for a "Oct 20, 12:00 AM" label plus the thinning gap. At the
 * shared 104px a 7-day plot gets 12h candidates that collide, and thinning drops them unevenly.
 */
const X_TICK_SPACING = 140

const valueAt = (row: Row, key: string): number | null => {
	const value = row[key]
	return typeof value === "number" ? value : null
}

/** The overview formats in the metric's unit; the detail grid's cells each name their formatter. */
const formatOf = (format: ToolSeriesFormat): ((value: number) => string) => {
	switch (format) {
		case "number":
			return formatNumber
		case "errorRate":
			return formatErrorRate
		case "durationNs":
			return formatDurationNs
		case "oneDecimal":
			return (value) => value.toFixed(1)
		default: {
			const metric = format
			return (value) => formatToolMetric(value, metric)
		}
	}
}

/** Tooltips read whole counts exactly; a fractional value (an average) keeps its decimals. */
export const tooltipFormatOf = (format: ToolSeriesFormat): ((value: number) => string) =>
	format === "number" || format === "calls" || format === "sessions"
		? (value) => (Number.isInteger(value) ? formatExactCount(value) : formatOf(format)(value))
		: formatOf(format)

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
			lineY(dropNullPoints(cells, valueOf), {
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
				x: {
					...axis.x,
					axis: { ...axis.x.axis, ticks: { ...axis.x.axis.ticks, spacing: X_TICK_SPACING } },
				},
				y: {
					grid: DASHED_Y_GRID,
					scale: scaleLinear().domain(yDomain),
					axis: {
						line: false,
						ticks: {
							size: 0,
							padding: 8,
							count: spec.tickCount ?? undefined,
							format: (value: number) => (value === 0 ? "0" : formatOf(spec.format)(value)),
						},
					},
				},
			},
			margin: { right: 8, top: spec.marginTop },
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
										value: tooltipFormatOf(spec.format)(value),
									},
								]
					}),
				}),
			),
	}
}
