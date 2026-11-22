import type { IssueSeverity } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { densifySpark, surgeRatio } from "../kit/error-signal"
import { Option, Array as Arr, Record as Rec } from "effect"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { bucketTooltipBody } from "@maple/views/charts/bucket-tooltip"
import * as Chart from "@maple/views/charts/chart"
import { ChartSpec } from "@maple/views/charts/chart-spec"
import { sortedOccurrences } from "@maple/views/charts/definitions/occurrences"
import { plotFrame } from "@maple/views/charts/plot-frame"
import { resolveColor, type ThemeColors } from "@maple/views/charts/theme-colors"
import { emptyMessage } from "@maple/views/ui/empty"
import { panelChartBody } from "@maple/views/ui/panel"
import { SEVERITY_TOKEN } from "../../kit/issue-severity"
import type { ChartWindow } from "./derive"
import { Message } from "./message"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { pressable } from "@maple/views/ui/pressable"
import type { ChartEventMarker, MarkerColors } from "@maple/views/charts/event-marker-spec"

type H = HtmlBuilder<Message>
type Point = Readonly<{ bucket: string; count: number }>

/** The tokens the chart reads off the theme: each severity's colour, and primary for unset. */
export const OCCURRENCE_TOKENS = [...Rec.values(SEVERITY_TOKEN), "--primary", "--muted-foreground"]

/** A bucket width as a short label: "15m", "1h". */
export const formatBucket = (bucketMs: number): string => {
	const seconds = Math.round(bucketMs / 1000)
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
	return `${Math.round(seconds / 86_400)}d`
}

export type ChartInputs = Readonly<{
	points: ReadonlyArray<Point>
	color: string
	timeZone: string
	markers: ReadonlyArray<ChartEventMarker>
	markerColors: MarkerColors
}>

/** The bars, or the dashed empty line when the window saw nothing. */
const chartView = Submodel.defineView<Chart.Model, Chart.Message, ChartInputs>((model, inputs, h) =>
	sortedOccurrences(inputs.points).length === 0
		? emptyMessage(
				h,
				{
					dashed: true,
					className:
						"flex h-44 w-full items-center justify-center border-border-subtle py-0 text-xs",
				},
				["No activity in this window"],
			)
		: plotFrame(h, {
				chartId: "issue-occurrences",
				className: "h-44 w-full",
				ariaLabel: "Occurrences over time",
				spec: ChartSpec.Occurrences({
					points: inputs.points,
					color: inputs.color,
					timeZone: inputs.timeZone,
					markers: inputs.markers,
					markerColors: inputs.markerColors,
				}),
				tooltipBody: (portal) =>
					Option.flatMap(model.tooltip, (tooltip) =>
						tooltip._tag === "Bucket"
							? Option.some(bucketTooltipBody(h, tooltip, portal))
							: Option.none(),
					),
			}),
)

/** Longest grid the chart fills; past it the sparse rows are drawn as they are. */
const MAX_FILLED_BUCKETS = 2000

/**
 * The window's buckets on the warehouse's grid, quiet ones as zero, so the axis and its markers
 * span the whole window rather than only the buckets that had errors.
 */
export const occurrencePointsOf = (
	points: ReadonlyArray<Point>,
	window: ChartWindow,
): ReadonlyArray<Point> => {
	if (window.bucketMs <= 0 || window.endMs <= window.startMs) return points
	const first = Math.floor(window.startMs / window.bucketMs) * window.bucketMs
	const length = Math.ceil((window.endMs - first) / window.bucketMs)
	if (length > MAX_FILLED_BUCKETS) return points
	const counts = new Map<number, number>()
	for (const point of points) {
		const ms = toEpochMs(point.bucket)
		counts.set(ms, (counts.get(ms) ?? 0) + point.count)
	}
	const grid = Arr.makeBy(length, (index) => first + index * window.bucketMs)
	const onGrid = new Set(grid)
	return [
		...Arr.map(grid, (ms) => ({ bucket: new Date(ms).toISOString(), count: counts.get(ms) ?? 0 })),
		...Arr.filter(points, (point) => !onGrid.has(toEpochMs(point.bucket))),
	]
}

/** The window's buckets, zero-filled, and how its tail compares with its own average. */
export const signalOf = (points: ReadonlyArray<Point>, window: ChartWindow) => {
	const dense = densifySpark(points, window)
	return { dense, surge: surgeRatio(dense) }
}

/** The chart's caption: what a bar counts, the tallest one, and that a bar zooms in. */
export const chartCaption = (h: H, peak: Html | string, bucketMs: number | null): Html =>
	hstack(h, { gap: "3", justify: "between", className: "mb-2" }, [
		typography(h, { size: "2xs", tone: "muted", weight: "medium" }, [
			bucketMs === null ? "Occurrences" : `Occurrences per ${formatBucket(bucketMs)}`,
		]),
		typography(h, { size: "2xs", tone: "muted", numeric: true }, [
			"Peak ",
			peak,
			" · click a bar to zoom in",
		]),
	])

export type OccurrenceChartInputs = Readonly<{
	points: ReadonlyArray<Point>
	severity: IssueSeverity | null
	window: ChartWindow
	markers: ReadonlyArray<ChartEventMarker>
	theme: ThemeColors
	timeZone: string
}>

/** The occurrences chart under its caption: the body of the occurrences panel, below its stats. */
export const occurrenceChart = (h: H, chart: Chart.Model, inputs: OccurrenceChartInputs): Html => {
	const { points, theme } = inputs
	const peak = Arr.reduce(points, 0, (max, point) => Math.max(max, point.count))
	const plot = h.submodel({
		slotId: "issue-occurrence-chart",
		model: chart,
		view: chartView,
		toParentMessage: (message) => Message.GotChartMessage({ message }),
		viewInputs: {
			points,
			color: resolveColor(
				theme,
				inputs.severity === null ? "--primary" : SEVERITY_TOKEN[inputs.severity],
			),
			timeZone: inputs.timeZone,
			markers: inputs.markers,
			markerColors: {
				neutral: resolveColor(theme, "--muted-foreground"),
				warn: resolveColor(theme, "--severity-warn"),
				crit: resolveColor(theme, "--severity-error"),
				label: resolveColor(theme, "--muted-foreground"),
			},
		},
	})
	return panelChartBody(h, [
		chartCaption(h, formatNumber(peak), inputs.window.bucketMs),
		// The chart tracks the hovered bar; a click zooms the page's window into it.
		peak === 0
			? plot
			: pressable(
					h,
					{
						onClick: Message.ClickedOccurrenceBar(),
						label: "Zoom into the hovered bar's time range",
						className: "block w-full cursor-zoom-in rounded-sm text-left",
					},
					[plot],
				),
	])
}
