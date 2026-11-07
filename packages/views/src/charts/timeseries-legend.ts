import { findFirstPartialIndex } from "@maple/ui/components/plot/partial-buckets"
import {
	computeSeriesStats,
	isAllZeroStats,
	type SeriesStats,
	type SeriesStatsMap,
	sortZeroSeriesLast,
} from "@maple/ui/components/plot/series-stats"
import { EMPTY_VALUE, formatValueByUnit } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { pressable } from "../ui/pressable"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../ui/table"
import { Message, type Model } from "./chart"
import { bucketSecondsOf, normaliseRows, scaleRates, type SeriesDefinition } from "./timeseries"
import { hstack } from "../ui/stack"
import { swatch } from "../ui/swatch"
import { Array as Arr } from "effect"
import { typography } from "../ui/typography"

// `TimeseriesLegend` (packages/ui/src/components/plot/timeseries.tsx): the compact legend or the
// Min/Max/Mean/Last table, below or beside the plot; shared by the line, area and bar charts.

export interface LegendSeries {
	readonly key: string
	readonly label: string
	readonly color: string
}

type LegendLayout = Readonly<{ isRight: boolean; maxHeight: number | null }>

/** `heightStyle(maxHeight)`: a side legend is capped at the container's height. */
const maxHeightStyle = (h: HtmlBuilder<Message>, layout: LegendLayout) =>
	layout.maxHeight === null ? [] : [h.Style({ "max-height": `${layout.maxHeight}px` })]

/** `QueryBuilderLegend variant="compact"`: a row per series, click to hide it. */
const compactLegend = (
	h: HtmlBuilder<Message>,
	series: ReadonlyArray<LegendSeries>,
	hidden: ReadonlyArray<string>,
	layout: LegendLayout,
): Html => {
	const keys = Arr.map(series, (entry) => entry.key)
	return h.div(
		[
			...maxHeightStyle(h, layout),
			h.Class(
				cn(
					"h-full overflow-auto text-xs",
					layout.isRight ? "flex flex-col gap-0.5 pl-3" : "flex flex-wrap gap-x-3 gap-y-0.5 pt-2",
				),
			),
		],
		Arr.map(series, (entry) =>
			pressable(
				h,
				{
					onClick: Message.ToggledLegendSeries({ key: entry.key, keys }),
					className: cn(
						"hover:bg-surface-sunken active:bg-surface-sunken flex min-w-0 max-w-full items-center gap-1.5 rounded-sm px-1 py-0.5 select-none",
						hidden.includes(entry.key) && "opacity-40",
					),
					attributes: [h.Key(entry.key), h.Title(entry.label)],
				},
				[swatch(h, { color: entry.color }), typography(h, { truncate: true }, [entry.label])],
			),
		),
	)
}

const STAT_COLUMNS: ReadonlyArray<{ label: string; field: keyof SeriesStats; className?: string }> = [
	{ label: "Min", field: "min", className: "hidden @lg:table-cell" },
	{ label: "Max", field: "max", className: "hidden @lg:table-cell" },
	{ label: "Mean", field: "mean" },
	{ label: "Last", field: "last" },
]

/** `QueryBuilderLegend variant="stats"`: swatch, label and four figures per series. */
const statsTable = (
	h: HtmlBuilder<Message>,
	series: ReadonlyArray<LegendSeries>,
	stats: SeriesStatsMap,
	hidden: ReadonlyArray<string>,
	unit: string | undefined,
	layout: LegendLayout,
): Html => {
	const keys = Arr.map(series, (entry) => entry.key)
	return h.div(
		[
			...maxHeightStyle(h, layout),
			h.Class(cn("@container h-full overflow-auto text-xs", layout.isRight ? "pl-3" : "pt-2")),
		],
		[
			// `bare` and no scroll: the kit frame only; `text-xs` keeps the legend's own size.
			table(
				h,
				{ variant: "bare", scroll: false, className: "w-full table-fixed border-collapse text-xs" },
				[
					tableHeader(h, [
						tableRow(
							h,
							[
								tableHead(h, ["Series"], "h-auto py-0.5 pl-0 pr-3"),
								...Arr.map(STAT_COLUMNS, (column) =>
									tableHead(
										h,
										[column.label],
										cn("h-auto w-20 px-2 py-0 text-right last:pr-0", column.className),
									),
								),
							],
							"text-muted-foreground",
						),
					]),
					tableBody(
						h,
						Arr.map(series, (entry) => {
							const entryStats = stats[entry.key] ?? null
							const allZero = isAllZeroStats(entryStats)
							return tableRow(
								h,
								[
									tableCell(
										h,
										[
											hstack(h, { gap: "1.5", shrink: true, as: "span" }, [
												swatch(h, { color: entry.color }),
												h.span(
													[
														h.Class(
															cn(
																"truncate",
																allZero && "text-muted-foreground",
															),
														),
														h.Title(entry.label),
													],
													[entry.label],
												),
											]),
										],
										"max-w-0 py-0.5 pl-0 pr-3 leading-4",
									),
									...Arr.map(STAT_COLUMNS, (column) =>
										entryStats === null || allZero
											? tableCell(
													h,
													column.field === "last"
														? [entryStats === null ? EMPTY_VALUE : "0"]
														: [],
													cn(
														"px-2 py-0 text-right font-mono leading-4 tabular-nums text-foreground-subtle last:pr-0",
														column.className,
													),
												)
											: tableCell(
													h,
													[formatValueByUnit(entryStats[column.field], unit)],
													cn(
														"px-2 py-0 text-right font-mono leading-4 tabular-nums last:pr-0",
														column.className,
													),
												),
									),
								],
								cn(
									"cursor-pointer select-none in-data-[variant=bare]:hover:bg-surface-sunken in-data-[variant=bare]:active:bg-surface-sunken",
									hidden.includes(entry.key) && "opacity-40",
								),
								[
									h.Key(entry.key),
									h.OnClick(Message.ToggledLegendSeries({ key: entry.key, keys })),
								],
							)
						}),
					),
				],
			),
		],
	)
}

export type TimeseriesLegendInputs = Readonly<{
	series: ReadonlyArray<LegendSeries>
	data: ReadonlyArray<Readonly<Record<string, unknown>>>
	definitions: ReadonlyArray<SeriesDefinition>
	unit: string | undefined
	nowMs: number
	legend: "hidden" | "visible" | "right" | undefined
	seriesStats: boolean
}>

/** The legend `PlotFrame` gets: nothing when hidden (the tile header hoists it instead). */
export const timeseriesLegend = (
	h: HtmlBuilder<Message>,
	model: Model,
	inputs: TimeseriesLegendInputs,
): Html => {
	const { series } = inputs
	if ((inputs.legend !== "visible" && inputs.legend !== "right") || series.length === 0) return h.empty
	// Stats over the closed buckets only, so all-zero series sink to the bottom (`TimeseriesLegend`).
	const keys = Arr.map(series, (entry) => entry.key)
	const normalised = normaliseRows(inputs.data, inputs.definitions)
	const rows = scaleRates(normalised, keys, inputs.unit, bucketSecondsOf(normalised))
	const first = findFirstPartialIndex(rows, { now: inputs.nowMs })
	const stats = computeSeriesStats(first <= 0 ? rows : rows.slice(0, first), keys)
	const sorted = sortZeroSeriesLast(series, stats)
	const layout: LegendLayout = {
		isRight: inputs.legend === "right",
		maxHeight: inputs.legend === "right" && model.containerHeight > 0 ? model.containerHeight : null,
	}
	return inputs.seriesStats
		? statsTable(h, sorted, stats, model.hiddenKeys, inputs.unit, layout)
		: compactLegend(h, sorted, model.hiddenKeys, layout)
}
