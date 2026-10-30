import { formatPercent } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	formatToolCount,
	formatToolMetric,
	metricSpark,
	metricValue,
	toolDelta,
	toolMetricLabel,
	type ToolDelta,
} from "@maple/web-data/lib/tool-analytics"
import type { Html, HtmlBuilder } from "foldkit/html"
import { delta } from "../../../ui/delta"
import { skeleton } from "../../../ui/skeleton"
import * as ToggleGroup from "../../../ui/toggle-group"
import type { ToolMetric, ToolPercentile, ToolSeriesPoint, ToolTotals } from "./model"
import { statRailItem } from "../../kit/stat-rail"

// The tool metric strip over selectable stat rail items.

const SPARK_WINDOW = 24
const TILE = "min-w-0 flex-1 border-l border-border first:border-l-0"

type TileOptions<M> = Readonly<{
	eyebrow: string
	value: string
	spark: ReadonlyArray<number>
	subline: Html | null
	isSelected: boolean
	onSelect: M
	ariaLabel?: string
	className: string
}>

/** `StatRailItem` with `onSelect`: the tile is a button that lights when its metric is drawn. */
export const selectableTile = <M>(h: HtmlBuilder<M>, options: TileOptions<M>): Html =>
	statRailItem(h, {
		eyebrow: options.eyebrow,
		value: options.value,
		spark: options.spark,
		sparkColor: "var(--primary)",
		subline: options.subline ?? undefined,
		onSelect: options.onSelect,
		isSelected: options.isSelected,
		ariaLabel: options.ariaLabel,
		className: options.className,
	})

const sublineText = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html | string>): Html =>
	h.span([h.Class("inline-flex items-center gap-1.5 font-mono tabular-nums")], children)

/** `ToolDeltaValue`: the change in the metric's own unit, graded by `toolDelta`. */
const deltaValue = <M>(h: HtmlBuilder<M>, change: ToolDelta): Html =>
	delta(h, {
		ratio: change.direction === "flat" ? 0 : change.direction === "up" ? 1 : -1,
		invert: change.direction === "up" ? !change.good : change.good,
		format: () => change.text,
	})

const deltaSubline = <M>(h: HtmlBuilder<M>, change: ToolDelta | null, windowLabel: string): Html | null =>
	change === null
		? null
		: sublineText(h, [
				deltaValue(h, change),
				h.span([h.Class("text-foreground-subtle")], ["vs prev ", windowLabel]),
			])

export type MetricStripConfig<M> = Readonly<{
	totals: ToolTotals
	previous: ToolTotals | undefined
	series: ReadonlyArray<ToolSeriesPoint>
	metric: ToolMetric
	percentile: ToolPercentile
	allSessions: number
	windowLabel: string
	onSelectMetric: (metric: ToolMetric) => M
	percentileToggle: ToggleGroup.Model
	toPercentileMessage: (message: ToggleGroup.Message) => M
}>

export const metricStrip = <M>(h: HtmlBuilder<M>, config: MetricStripConfig<M>): Html => {
	const { totals, previous, series, percentile } = config
	const tile = (key: Exclude<ToolMetric, "duration">, eyebrow: string) => {
		const share =
			key === "sessions" && config.allSessions > 0 ? totals.sessions / config.allSessions : undefined
		return selectableTile(h, {
			eyebrow,
			value: formatToolMetric(metricValue(totals, key, percentile), key),
			spark: metricSpark(series, key, percentile).slice(-SPARK_WINDOW),
			subline:
				share === undefined
					? deltaSubline(h, toolDelta(totals, previous, key, percentile), config.windowLabel)
					: sublineText(h, [
							h.span([], [formatPercent(share)]),
							h.span(
								[h.Class("text-foreground-subtle")],
								["of all ", formatToolCount(config.allSessions), " sessions"],
							),
						]),
			isSelected: config.metric === key,
			onSelect: config.onSelectMetric(key),
			className: TILE,
		})
	}
	return h.div(
		[h.Class("flex flex-wrap border-b border-border @max-[900px]/page:flex-col")],
		[
			tile("calls", "Tool calls"),
			tile("sessions", "Sessions"),
			tile("error_rate", "Error rate"),
			h.div(
				[h.Class(cn("relative", TILE))],
				[
					selectableTile(h, {
						eyebrow: "Duration",
						value: formatToolMetric(totals[percentile], "duration"),
						spark: metricSpark(series, "duration", percentile).slice(-SPARK_WINDOW),
						subline: deltaSubline(
							h,
							toolDelta(totals, previous, "duration", percentile),
							config.windowLabel,
						),
						isSelected: config.metric === "duration",
						onSelect: config.onSelectMetric("duration"),
						ariaLabel: toolMetricLabel("duration", percentile),
						className: "h-full",
					}),
					ToggleGroup.view(h, {
						model: config.percentileToggle,
						toParentMessage: config.toPercentileMessage,
						items: (["p50", "p90", "p95"] as const).map((value) => ({ value, label: value })),
						variant: "outline",
						size: "sm",
						className: "absolute top-3 right-5 p-px",
						itemClassName:
							"h-5 min-w-0 px-1.5 font-mono text-3xs uppercase sm:h-5 sm:min-w-0 sm:text-3xs",
					}),
				],
			),
		],
	)
}

/** `ToolMetricStripLoading`. */
export const metricStripLoading = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("flex border-b border-border"), h.AriaBusy(true)],
		Array.from({ length: 4 }, () =>
			h.div(
				[h.Class(cn("px-5 py-4", TILE))],
				[
					skeleton(h, "h-3 w-16"),
					h.div(
						[h.Class("mt-3 flex items-end justify-between gap-3")],
						[skeleton(h, "h-7 w-20"), skeleton(h, "h-7 w-24")],
					),
					skeleton(h, "mt-3 h-3 w-28"),
				],
			),
		),
	)
