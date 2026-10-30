import type { IssueSeverity } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { densifySpark, surgeRatio } from "../../../lib/models/error-signal"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import { ChartSpec } from "../../../charts/chart-spec"
import { sortedOccurrences } from "../../../charts/definitions/occurrences"
import { plotFrame } from "../../../charts/plot-frame"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { emptyMessage } from "../../../ui/empty"
import { eyebrow } from "../../../ui/eyebrow"
import { panel, panelHeader } from "../../../ui/panel"
import { SEVERITY_TOKEN } from "../kit/severity"
import type { ChartWindow } from "./derive"
import { Message } from "./message"

// `IssueOccurrencePanel` and `IssueOccurrenceChart` (components/errors/).

type H = HtmlBuilder<Message>
type Point = Readonly<{ bucket: string; count: number }>

const SURGE_THRESHOLD = 2.5

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
const chartView = Submodel.defineView<Chart.Model, Chart.Message, ChartInputs>((_model, inputs, h) =>
	sortedOccurrences(inputs.points).length === 0
		? emptyMessage(
				h,
				{
					dashed: true,
					className: "flex h-44 w-full items-center justify-center border-border/60 py-0 text-xs",
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
				tooltipBody: () => Option.none(),
			}),
)

const CHART_MODEL = Chart.init()

export const occurrencePanel = (
	h: H,
	points: ReadonlyArray<Point>,
	severity: IssueSeverity | null,
	window: ChartWindow,
	theme: ThemeColors,
	timeZone: string,
): Html => {
	const dense = densifySpark(points, window)
	const ratio = surgeRatio(dense)
	const peak = points.reduce((max, point) => Math.max(max, point.count), 0)
	const isSurging = ratio !== null && ratio >= SURGE_THRESHOLD
	return panel(h, { className: "shrink-0" }, [
		panelHeader(h, {
			title: "Occurrences",
			scope: h.span(
				[h.Class("text-2xs text-muted-foreground")],
				[
					"peak ",
					h.span([h.Class("tabular-nums")], [formatNumber(peak)]),
					" per",
					" ",
					formatBucket(window.bucketMs),
				],
			),
			action: isSurging ? eyebrow(h, { className: "text-severity-error" }, ["Surging"]) : undefined,
			divided: false,
			className: "px-3 pt-2.5",
		}),
		h.div(
			[h.Class("px-3 pt-2 pb-3")],
			[
				h.submodel({
					slotId: "issue-occurrence-chart",
					model: CHART_MODEL,
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
