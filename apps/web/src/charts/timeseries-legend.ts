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
import { Message, type Model } from "./chart"
import { bucketSecondsOf, normaliseRows, scaleRates, type SeriesDefinition } from "./timeseries"

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
	const keys = series.map((entry) => entry.key)
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
		series.map((entry) =>
			h.button(
				[
					h.Key(entry.key),
					h.Type("button"),
					h.Class(
						cn(
							"hover:bg-muted/50 flex min-w-0 max-w-full items-center gap-1.5 rounded px-1 py-0.5 select-none",
							hidden.includes(entry.key) && "opacity-40",
						),
					),
					h.Title(entry.label),
					h.OnClick(Message.ToggledLegendSeries({ key: entry.key, keys })),
				],
				[
					h.span([
						h.Class("size-2 shrink-0 rounded-xs"),
						h.Style({ "background-color": entry.color }),
					]),
					h.span([h.Class("truncate")], [entry.label]),
				],
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
	const keys = series.map((entry) => entry.key)
	return h.div(
		[
			...maxHeightStyle(h, layout),
			h.Class(cn("@container h-full overflow-auto text-xs", layout.isRight ? "pl-3" : "pt-2")),
		],
		[
			h.table(
				[h.Class("w-full table-fixed border-collapse")],
				[
					h.thead(
						[],
						[
							h.tr(
								[h.Class("text-muted-foreground")],
								[
									h.th([h.Class("py-0.5 pr-3 text-left font-normal")], ["Series"]),
									...STAT_COLUMNS.map((column) =>
										h.th(
											[
												h.Class(
													cn(
														"w-20 px-2 text-right font-normal last:pr-0",
														column.className,
													),
												),
											],
											[column.label],
										),
									),
								],
							),
						],
					),
					h.tbody(
						[],
						series.map((entry) => {
							const entryStats = stats[entry.key] ?? null
							const allZero = isAllZeroStats(entryStats)
							return h.keyed("tr")(
								entry.key,
								[
									h.OnClick(Message.ToggledLegendSeries({ key: entry.key, keys })),
									h.Class(
										cn(
											"hover:bg-muted/50 cursor-pointer select-none",
											hidden.includes(entry.key) && "opacity-40",
										),
									),
								],
								[
									h.td(
										[h.Class("max-w-0 py-0.5 pr-3")],
										[
											h.span(
												[h.Class("flex min-w-0 items-center gap-1.5")],
												[
													h.span([
														h.Class("size-2 shrink-0 rounded-xs"),
														h.Style({ "background-color": entry.color }),
													]),
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
												],
											),
										],
									),
									...STAT_COLUMNS.map((column) =>
										entryStats === null || allZero
											? h.td(
													[
														h.Class(
															cn(
																"px-2 text-right font-mono tabular-nums text-muted-foreground/60 last:pr-0",
																column.className,
															),
														),
													],
													column.field === "last"
														? [entryStats === null ? EMPTY_VALUE : "0"]
														: [],
												)
											: h.td(
													[
														h.Class(
															cn(
																"px-2 text-right font-mono tabular-nums last:pr-0",
																column.className,
															),
														),
													],
													[formatValueByUnit(entryStats[column.field], unit)],
												),
									),
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
	const keys = series.map((entry) => entry.key)
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
