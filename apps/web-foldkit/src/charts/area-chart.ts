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
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { Message, type Model } from "./chart"
import { MeasureChartContainer } from "./chart-mounts"
import { ChartSpec, ChartTooltip } from "./chart-spec"
import { bucketTooltipBody } from "./bucket-tooltip"
import { plotFrame } from "./plot-frame"
import { resolveColor, type ThemeColors } from "./theme-colors"
import {
	bucketSecondsOf,
	normaliseRows,
	scaleRates,
	SERIES_FALLBACK_COLOR,
	seriesColorTokens,
	seriesDefinitionsOf,
} from "./timeseries"

// Port of `QueryBuilderAreaChart` + `Timeseries.Frame` (packages/ui/src/components/charts/area/,
// plot/timeseries.tsx) for an unstacked chart with a hidden or compact bottom legend.
// TODO(legend): `legend="right"` and the hoisted header legend are not ported.

/** The tokens a chart's series and chrome can resolve to; a page reads them with `ResolveThemeColors`. */
export const AREA_CHART_TOKENS = [
	"--border",
	"--background",
	"var(--chart-1)",
	"var(--chart-p50)",
	"var(--chart-p95)",
	"var(--chart-p99)",
	"var(--severity-info)",
	"var(--severity-error)",
	"var(--severity-warn)",
	"var(--muted-foreground)",
]

export interface AreaChartInputs {
	readonly chartId: string
	readonly data: ReadonlyArray<Readonly<Record<string, string | number | boolean>>>
	readonly theme: ThemeColors
	readonly unit?: string | undefined
	readonly timeZone?: string | undefined
	/** The clock the in-flight tail is judged against (`Date.now()` in the React chart). */
	readonly nowMs: number
	readonly className?: string
	readonly showTooltip?: boolean
	/** `legend="visible"`: the compact strip under the plot; otherwise the legend hoists (nothing here). */
	readonly legend?: "hidden" | "visible"
	/** `QueryBuilderLineChart`: lines instead of bands. */
	readonly mark?: "area" | "line"
	readonly stacked?: boolean
	readonly curveType?: "linear" | "monotone"
	readonly showPoints?: boolean
	/** `seriesStats`: the visible legend is the Min/Max/Mean/Last table. */
	readonly seriesStats?: boolean
}

interface LegendSeries {
	readonly key: string
	readonly label: string
	readonly color: string
}

/** `QueryBuilderLegend variant="compact" layout="bottom"`: a row per series, click to hide it. */
const compactLegend = (
	h: HtmlBuilder<Message>,
	series: ReadonlyArray<LegendSeries>,
	hidden: ReadonlyArray<string>,
): Html => {
	const keys = series.map((entry) => entry.key)
	return h.div(
		[h.Class("h-full overflow-auto text-xs flex flex-wrap gap-x-3 gap-y-0.5 pt-2")],
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

/** `QueryBuilderLegend variant="stats" layout="bottom"`: swatch, label and four figures per series. */
const statsTable = (
	h: HtmlBuilder<Message>,
	series: ReadonlyArray<LegendSeries>,
	stats: SeriesStatsMap,
	hidden: ReadonlyArray<string>,
	unit: string | undefined,
): Html => {
	const keys = series.map((entry) => entry.key)
	return h.div(
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

const tooltipBody = (
	h: HtmlBuilder<Message>,
	tooltip: ChartTooltip,
	portal: Attribute<Message>,
): Option.Option<Html> =>
	ChartTooltip.match(tooltip, {
		Bucket: (bucket) => Option.some(bucketTooltipBody(h, bucket, portal)),
		PieSlice: () => Option.none(),
		NumericBin: () => Option.none(),
		CategoricalBin: () => Option.none(),
	})

export const view = Submodel.defineView<Model, Message, AreaChartInputs>((model, inputs, h) => {
	const { definitions } = seriesDefinitionsOf(inputs.data)
	const tokens = seriesColorTokens(definitions)
	const colors = Object.fromEntries(
		definitions.map((definition) => [
			definition.chartKey,
			resolveColor(
				inputs.theme,
				tokens.get(definition.chartKey) ?? SERIES_FALLBACK_COLOR,
				SERIES_FALLBACK_COLOR,
			),
		]),
	)
	const series = definitions.map((definition) => ({
		key: definition.chartKey,
		label: definition.rawKey,
		color: colors[definition.chartKey] ?? SERIES_FALLBACK_COLOR,
	}))
	const legend = (() => {
		if (inputs.legend !== "visible" || series.length === 0) return h.empty
		// Stats over the closed buckets only, so all-zero series sink to the bottom (`TimeseriesLegend`).
		const keys = series.map((entry) => entry.key)
		const normalised = normaliseRows(inputs.data, definitions)
		const rows = scaleRates(normalised, keys, inputs.unit, bucketSecondsOf(normalised))
		const first = findFirstPartialIndex(rows, { now: inputs.nowMs })
		const stats = computeSeriesStats(first <= 0 ? rows : rows.slice(0, first), keys)
		const sorted = sortZeroSeriesLast(series, stats)
		return inputs.seriesStats === true
			? statsTable(h, sorted, stats, model.hiddenKeys, inputs.unit)
			: compactLegend(h, sorted, model.hiddenKeys)
	})()
	return h.div(
		[h.Class(cn("h-full w-full", inputs.className)), h.OnMount(MeasureChartContainer())],
		[
			plotFrame(h, {
				chartId: inputs.chartId,
				className: "h-full w-full",
				ariaLabel: "Time series",
				spec: ChartSpec.QueryBuilderArea({
					data: inputs.data,
					colors,
					hidden: model.hiddenKeys,
					fallbackColor: SERIES_FALLBACK_COLOR,
					chrome: {
						border: resolveColor(inputs.theme, "--border"),
						background: resolveColor(inputs.theme, "--background"),
					},
					unit: inputs.unit ?? null,
					timeZone: inputs.timeZone ?? null,
					nowMs: inputs.nowMs,
					containerWidth: model.containerWidth,
					gradientPrefix: `qbArea-${inputs.chartId}`,
					showTooltip: inputs.showTooltip ?? true,
					...(inputs.mark === undefined ? undefined : { mark: inputs.mark }),
					...(inputs.stacked === undefined ? undefined : { stacked: inputs.stacked }),
					...(inputs.curveType === undefined ? undefined : { curve: inputs.curveType }),
					...(inputs.showPoints === undefined ? undefined : { showPoints: inputs.showPoints }),
				}),
				// A hoisting `TimeseriesLegend` renders nothing, but `PlotFrame` still gets an element.
				legend,
				tooltipBody: (portal) =>
					Option.flatMap(model.tooltip, (tooltip) => tooltipBody(h, tooltip, portal)),
			}),
		],
	)
})
