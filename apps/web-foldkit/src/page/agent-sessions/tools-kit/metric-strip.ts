import { VALUE_TONE } from "@maple/web/components/infra/severity-tokens"
import { formatPercent } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
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
import { miniBars } from "../../../ui/mini-bars"
import { skeleton } from "../../../ui/skeleton"
import { statFigure } from "../../../ui/stat-figure"
import * as ToggleGroup from "../../../ui/toggle-group"
import type { ToolMetric, ToolPercentile, ToolSeriesPoint, ToolTotals } from "./model"

// `ToolMetricStrip` (agent-sessions/tools/tool-metric-strip.tsx) over the selectable `StatRailItem`
// (components/common/stat-rail.tsx).

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
	h.button(
		[
			...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
			h.AriaPressed(String(options.isSelected)),
			h.Class(
				cn(
					cn("relative animate-in fade-in slide-in-from-bottom-1 duration-500", "px-5 py-4", options.className),
					"w-full text-left",
					rowSelectedClass(options.isSelected),
					"cursor-pointer hover:bg-muted/25",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
				),
			),
			h.Type("button"),
			h.OnClick(options.onSelect),
		],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-3")],
				[
					h.span(
						[
							h.Class(
								cn(
									"truncate text-2xs font-medium transition-colors",
									options.isSelected ? "text-primary" : "text-muted-foreground",
								),
							),
						],
						[options.eyebrow],
					),
				],
			),
			h.div(
				[h.Class(cn("flex items-end justify-between gap-3", "mt-2"))],
				[
					statFigure(h, {
						value: options.value,
						size: "lg",
						className: "shrink-0",
						valueClassName: cn(VALUE_TONE.neutral),
					}),
					options.spark.length > 1
						? miniBars(h, {
								values: options.spark.slice(-28),
								color: "var(--primary)",
								opacityRamp: true,
								className: "h-7 w-24 min-w-0 shrink",
							})
						: h.div([h.Class("h-7 w-24 min-w-0 shrink")], []),
				],
			),
			...(options.subline === null
				? []
				: [h.div([h.Class("mt-2 truncate text-2xs text-muted-foreground")], [options.subline])]),
		],
	)

const sublineText = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html | string>): Html =>
	h.span([h.Class("inline-flex items-center gap-[5px] font-mono tabular-nums")], children)

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
				h.span([h.Class("text-muted-foreground/60")], ["vs prev ", windowLabel]),
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
		const share = key === "sessions" && config.allSessions > 0 ? totals.sessions / config.allSessions : undefined
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
								[h.Class("text-muted-foreground/60")],
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
						subline: deltaSubline(h, toolDelta(totals, previous, "duration", percentile), config.windowLabel),
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
						itemClassName: "h-5 min-w-0 px-1.5 font-mono text-3xs uppercase sm:h-5 sm:min-w-0 sm:text-3xs",
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
