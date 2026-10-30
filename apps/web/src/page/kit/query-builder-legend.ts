import { isAllZeroStats, type SeriesStats, type SeriesStatsMap } from "@maple/ui/components/plot/series-stats"
import { EMPTY_VALUE, formatValueByUnit } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// `QueryBuilderLegend` (packages/ui/src/components/charts/_shared/query-builder-legend.tsx), bottom
// layout, for hosts outside a chart. The chart's own copy lives in `charts/area-chart.ts`.

export type LegendSeries = Readonly<{ key: string; label: string; color: string }>

export type QueryBuilderLegendOptions<M> = Readonly<{
	series: ReadonlyArray<LegendSeries>
	stats: SeriesStatsMap
	hidden: ReadonlyArray<string>
	onToggle: (key: string) => M
	unit?: string
	variant?: "compact" | "stats"
}>

const STAT_COLUMNS: ReadonlyArray<{ label: string; field: keyof SeriesStats; className?: string }> = [
	{ label: "Min", field: "min", className: "hidden @lg:table-cell" },
	{ label: "Max", field: "max", className: "hidden @lg:table-cell" },
	{ label: "Mean", field: "mean" },
	{ label: "Last", field: "last" },
]

const swatch = <M>(h: HtmlBuilder<M>, color: string): Html =>
	h.span([h.Class("size-2 shrink-0 rounded-xs"), h.Style({ "background-color": color })])

/** The colour key: swatch and label per series, wrapped. */
const compactStrip = <M>(h: HtmlBuilder<M>, options: QueryBuilderLegendOptions<M>): Html =>
	h.div(
		[h.Class("h-full overflow-auto text-xs flex flex-wrap gap-x-3 gap-y-0.5 pt-2")],
		options.series.map((entry) =>
			h.button(
				[
					h.Key(entry.key),
					h.Type("button"),
					h.OnClick(options.onToggle(entry.key)),
					h.Class(
						cn(
							"hover:bg-surface-sunken flex min-w-0 max-w-full items-center gap-1.5 rounded-sm px-1 py-0.5 select-none",
							options.hidden.includes(entry.key) && "opacity-40",
						),
					),
					h.Title(entry.label),
				],
				[swatch(h, entry.color), h.span([h.Class("truncate")], [entry.label])],
			),
		),
	)

/** No data reads as a dash glyph and four zeros collapse to one muted 0, both in the Last column. */
const statCells = <M>(h: HtmlBuilder<M>, stats: SeriesStats | null, unit: string | undefined) =>
	STAT_COLUMNS.map((column) =>
		stats === null || isAllZeroStats(stats)
			? h.td(
					[
						h.Class(
							cn(
								"px-2 text-right font-mono tabular-nums text-foreground-subtle last:pr-0",
								column.className,
							),
						),
					],
					column.field === "last" ? [stats === null ? EMPTY_VALUE : "0"] : [],
				)
			: h.td(
					[h.Class(cn("px-2 text-right font-mono tabular-nums last:pr-0", column.className))],
					[formatValueByUnit(stats[column.field], unit)],
				),
	)

/** The colour key plus the per-series Min/Max/Mean/Last columns. */
const statsTable = <M>(h: HtmlBuilder<M>, options: QueryBuilderLegendOptions<M>): Html =>
	h.div(
		[h.Class("@container h-full overflow-auto text-xs pt-2")],
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
						options.series.map((entry) => {
							const stats = options.stats[entry.key] ?? null
							return h.keyed("tr")(
								entry.key,
								[
									h.OnClick(options.onToggle(entry.key)),
									h.Class(
										cn(
											"hover:bg-surface-sunken cursor-pointer select-none",
											options.hidden.includes(entry.key) && "opacity-40",
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
													swatch(h, entry.color),
													h.span(
														[
															h.Class(
																cn(
																	"truncate",
																	isAllZeroStats(stats) &&
																		"text-muted-foreground",
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
									...statCells(h, stats, options.unit),
								],
							)
						}),
					),
				],
			),
		],
	)

/** `QueryBuilderLegend` with `layout="bottom"`; nothing for no series. */
export const queryBuilderLegend = <M>(h: HtmlBuilder<M>, options: QueryBuilderLegendOptions<M>): Html =>
	options.series.length === 0
		? h.empty
		: (options.variant ?? "stats") === "compact"
			? compactStrip(h, options)
			: statsTable(h, options)
