import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { barY, defineChart } from "@tanstack/charts"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import * as React from "react"

import type { IssueSeverity } from "@maple/domain/http"
import {
	CursorPlot,
	DASHED_Y_GRID,
	bucketDate,
	integerTickValues,
	linearYDomain,
	makeBucketAxis,
	minBarLength,
	niceLinearDomain,
	useCursorPlot,
	type CursorPlotSeries,
} from "@maple/ui/components/plot"
import { cn } from "@maple/ui/lib/utils"
import { formatNumber } from "@maple/ui/lib/format"

import { SEVERITY_TOKEN } from "./severity-badge"

// A type alias, not an interface: only an alias gets TypeScript's implicit index
// signature, which is what lets a row be read by key name — `linearYDomain` takes
// `Record<string, unknown>` rows.
type TimeseriesPoint = {
	bucket: string
	count: number
}

interface IssueOccurrenceChartProps {
	data: ReadonlyArray<TimeseriesPoint>
	/** Tints the plot to match the issue's severity chip and the list row's
	 *  `SignalSpark`. `null` keeps the neutral primary. */
	severity?: IssueSeverity | null
	className?: string
}

/**
 * Occurrences per bucket, as bars.
 *
 * Bars, not the gradient area this used to draw: the series is a count per
 * discrete bucket, and an area implies a continuous quantity sampled at those
 * points. The difference is not academic — the filled band interpolated straight
 * across a bucket with no errors, so silence read as steady traffic, which is
 * exactly the mistake `densifySpark` exists to stop the list row making. It also
 * puts the detail chart in the same visual language as `SignalSpark`, so a shape
 * you recognised in the queue is the same shape when you open it.
 *
 * Both axes are drawn now. Hidden axes were defensible while this was an 80px
 * sparkline read against numbers printed beside it; at panel size a chart with no
 * scale is decoration.
 */
// The badge's severity tokens, so a high-severity issue's bars match its badge.
const SEVERITY_COLOR_TOKENS = {
	...SEVERITY_TOKEN,
	unset: "--primary",
} satisfies Record<IssueSeverity | "unset", `--${string}`>

export function IssueOccurrenceChart({ data, severity = null, className }: IssueOccurrenceChartProps) {
	const color = SEVERITY_COLOR_TOKENS[severity ?? "unset"]
	const series = React.useMemo<CursorPlotSeries<TimeseriesPoint>[]>(
		() => [
			{
				key: "count",
				label: "Occurrences",
				color,
				value: (point: TimeseriesPoint) => point.count,
				format: (value: number) => value.toLocaleString(),
			},
		],
		[color],
	)
	const plot = useCursorPlot(series)

	const sorted = React.useMemo<TimeseriesPoint[]>(
		() =>
			[...data]
				// A point with an unparseable bucket has no position on the axis.
				.filter((point) => Number.isFinite(Date.parse(point.bucket)))
				.sort((a, b) => Date.parse(a.bucket) - Date.parse(b.bucket)),
		[data],
	)

	const { effectiveTimezone: timeZone } = useTimezonePreference()
	const axis = React.useMemo(
		() =>
			makeBucketAxis(
				sorted.map((point) => point.bucket),
				timeZone,
			),
		[sorted, timeZone],
	)

	/**
	 * An EXPLICIT count domain, anchored at zero and rounded to the ticks drawn.
	 *
	 * The bare `scaleLinear` factory infers from the data extent, which is the one
	 * inference `plot-scales` exists to prevent — and an inferred domain has no
	 * span to take a minimum bar length from. Counts, so the ticks are whole.
	 */
	const yDomain = React.useMemo(
		() => niceLinearDomain(linearYDomain({ rows: sorted, keys: ["count"] })),
		[sorted],
	)
	// A single occurrence in an hour of quiet is the reading this chart exists to
	// show, and against a domain topping out in the thousands it paints as
	// nothing. See `minBarLength`.
	const liftCount = React.useMemo(() => minBarLength(yDomain), [yDomain])

	const definition = React.useMemo(
		() =>
			defineChart({
				marks: [
					barY(sorted, {
						x: (point: TimeseriesPoint) => bucketDate(point.bucket),
						y: (point: TimeseriesPoint) => liftCount(point.count),
						fill: plot.color("count"),
						radius: 2,
					}),
				],
				scales: {
					x: axis.xBand,
					y: {
						grid: DASHED_Y_GRID,
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
				// Room for the axes to actually draw in. `bottom: 0` clipped the x tick
				// labels out of existence and cut the y axis's own "0" in half — the
				// plot area is the frame minus these, so an axis with no margin has
				// nowhere to put its labels.
				margin: { top: 8, right: 4, bottom: 22, left: 44 },
				focus: "group-x",
				focusRing: false,
				tooltip: plot.tooltip,
			}),
		[sorted, plot, axis, yDomain, liftCount],
	)

	if (sorted.length === 0) {
		return (
			<EmptyMessage
				dashed
				className={cn(
					"flex h-44 w-full items-center justify-center border-border/50 py-0 text-xs",
					className,
				)}
			>
				No activity in this window
			</EmptyMessage>
		)
	}

	return (
		<CursorPlot
			plot={plot}
			definition={definition}
			series={series}
			heading={(point: TimeseriesPoint) => axis.heading(point.bucket)}
			ariaLabel="Occurrences over time"
			className={cn("h-44 w-full", className)}
		/>
	)
}
