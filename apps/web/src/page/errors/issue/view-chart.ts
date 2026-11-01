import type { IssueSeverity } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { densifySpark, surgeRatio } from "../../../lib/models/error-signal"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { bucketTooltipBody } from "../../../charts/bucket-tooltip"
import * as Chart from "../../../charts/chart"
import { ChartSpec } from "../../../charts/chart-spec"
import { sortedOccurrences } from "../../../charts/definitions/occurrences"
import { plotFrame } from "../../../charts/plot-frame"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { emptyMessage } from "../../../ui/empty"
import { panel, panelHeader } from "../../../ui/panel"
import { SEVERITY_TOKEN } from "../kit/severity"
import type { ChartWindow } from "./derive"
import { Message } from "./message"

// `IssueOccurrencePanel` and `IssueOccurrenceChart` (components/errors/).

type H = HtmlBuilder<Message>
type Point = Readonly<{ bucket: string; count: number }>

/** The tokens the chart reads off the theme: each severity's colour, and primary for unset. */
export const OCCURRENCE_TOKENS = [...Object.values(SEVERITY_TOKEN), "--primary"]

const formatBucket = (bucketMs: number): string => {
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
}>

/** `IssueOccurrenceChart`: the bars, or the dashed empty line when the window saw nothing. */
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
				}),
				tooltipBody: (portal) =>
					Option.flatMap(model.tooltip, (tooltip) =>
						tooltip._tag === "Bucket"
							? Option.some(bucketTooltipBody(h, tooltip, portal))
							: Option.none(),
					),
			}),
)

/** The window's buckets, zero-filled, and how its tail compares with its own average. */
export const signalOf = (points: ReadonlyArray<Point>, window: ChartWindow) => {
	const dense = densifySpark(points, window)
	return { dense, surge: surgeRatio(dense) }
}

export const occurrencePanel = (
	h: H,
	chart: Chart.Model,
	points: ReadonlyArray<Point>,
	severity: IssueSeverity | null,
	window: ChartWindow,
	theme: ThemeColors,
	timeZone: string,
): Html => {
	const peak = points.reduce((max, point) => Math.max(max, point.count), 0)
	return panel(h, { className: "shrink-0 overflow-hidden" }, [
		panelHeader(h, {
			title: "Occurrences",
			scope: h.span(
				[h.Class("font-mono text-2xs text-muted-foreground tabular-nums")],
				[`Peak ${formatNumber(peak)} / ${formatBucket(window.bucketMs)}`],
			),
		}),
		h.div(
			[h.Class("px-4 pt-3 pb-4")],
			[
				h.submodel({
					slotId: "issue-occurrence-chart",
					model: chart,
					view: chartView,
					toParentMessage: (message) => Message.GotChartMessage({ message }),
					viewInputs: {
						points,
						color: resolveColor(
							theme,
							severity === null ? "--primary" : SEVERITY_TOKEN[severity],
						),
						timeZone,
					},
				}),
			],
		),
	])
}
