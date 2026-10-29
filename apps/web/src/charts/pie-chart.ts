import {
	bucketCategorical,
	MAX_CATEGORICAL,
	OTHER_COLOR,
	OTHER_LABEL,
	type CategoricalRow,
} from "@maple/ui/components/charts/_shared/bucket-series"
import { EMPTY_VALUE, formatNumber, formatPercent, formatValueByUnit } from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html } from "foldkit/html"
import { type ChartAttribute, ChartBlock, type ChartViewBuilder, type Model } from "./chart"
import { ChartSpec, ChartTooltip, type PieSliceRow } from "./chart-spec"
import { MeasureChartContainer } from "./chart-mounts"
import { plotFrame } from "./plot-frame"
import { legendRow, type PlotLegendSeries, statsLegend } from "./plot-legend"
import { resolveColor, type ThemeColors } from "./theme-colors"

// Port of `QueryBuilderPieChart` (packages/ui/src/components/charts/pie/query-builder-pie-chart.tsx),
// view half. The definition half is `buildPie` in ./definitions/pie.ts.

export interface PieChartInputs {
	readonly chartId: string
	readonly data: ReadonlyArray<Record<string, unknown>>
	readonly theme: ThemeColors
	readonly className?: string
	readonly legend?: "visible" | "hidden" | "right"
	readonly tooltip?: "visible" | "hidden"
	readonly unit?: string
	readonly donut?: boolean
	readonly innerRadius?: number
	readonly showLabels?: boolean
	readonly showPercent?: boolean
}

const TABLE_LEGEND_RATIO = 0.45
const TABLE_FIXED_W = 116
const TABLE_LEGEND_MIN_W = TABLE_FIXED_W + 52
const TABLE_LEGEND_MAX_W = 240
const TABLE_MIN_PIE_W = 120
const CHIP_STRIP_CLASS = "max-h-[50px] justify-center overflow-hidden"
const SLICE_FALLBACK = "#a1a1aa"
const LEGEND_LABEL = "Share by category"

const asFiniteNumber = (value: unknown): number => {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

const pickValueField = (rows: ReadonlyArray<Record<string, unknown>>): string => {
	const first = rows[0]
	if (first === undefined) return "value"
	return Object.keys(first).find((key) => key !== "name" && typeof first[key] === "number") ?? "value"
}

const fmtValue = (value: number, unit: string | undefined): string =>
	unit ? formatValueByUnit(value, unit) : formatNumber(value)

const clamp = (value: number, lo: number, hi: number): number =>
	Number.isFinite(value) ? Math.max(lo, Math.min(hi, value)) : lo

/** The `rows`/`colorTokens`/`total` memo: parsed, positive, long tail bucketed into "Other". */
const pieRowsOf = (source: ReadonlyArray<Record<string, unknown>>) => {
	const valueField = pickValueField(source)
	const parsed: CategoricalRow[] = source
		.map((row) => {
			const raw = row.name == null ? "" : String(row.name).trim()
			return { name: raw === "" ? "(no value)" : raw, value: asFiniteNumber(row[valueField]) }
		})
		.filter((row) => row.value > 0)
	const rows = bucketCategorical(parsed, MAX_CATEGORICAL)
	const total = rows.reduce((sum, row) => sum + row.value, 0)
	const byName = resolveSeriesColors(rows.map((row) => row.name).filter((name) => name !== OTHER_LABEL))
	const colorTokens = new Map(
		rows.map((row) => [
			row.name,
			row.name === OTHER_LABEL ? OTHER_COLOR : (byName.get(row.name) ?? OTHER_COLOR),
		]),
	)
	return { rows, colorTokens, total }
}

/** Every token the pie reads, for `ResolveThemeColors`. */
export const pieChartTokens = (data: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> => [
	"--background",
	...pieRowsOf(data).colorTokens.values(),
]

const tooltipBody = (
	h: ChartViewBuilder,
	tooltip: ChartTooltip,
	unit: string | undefined,
	portal: ChartAttribute,
): Option.Option<Html> =>
	ChartTooltip.match(tooltip, {
		PieSlice: (slice) =>
			Option.some(
				h.div(
					[h.Class("whitespace-nowrap text-2xs"), portal],
					[
						h.div(
							[h.Class("flex items-center gap-1.5 font-medium text-foreground")],
							[
								h.span([
									h.Class("size-2 rounded-xs"),
									h.Style({ "background-color": slice.color }),
								]),
								h.span([], [slice.name]),
								...(slice.collapsedCount
									? [
											h.span(
												[h.Class("font-normal text-muted-foreground")],
												[`(${slice.collapsedCount} categories)`],
											),
										]
									: []),
							],
						),
						h.div(
							[h.Class("mt-0.5 text-muted-foreground tabular-nums")],
							[
								h.span([h.Class("text-foreground/90")], [fmtValue(slice.value, unit)]),
								h.span([h.Class("px-1 text-muted-foreground/60")], ["·"]),
								h.span([], [formatPercent(slice.fraction)]),
							],
						),
					],
				),
			),
		NumericBin: () => Option.none(),
		CategoricalBin: () => Option.none(),
		HeatmapSlot: () => Option.none(),
		Bucket: () => Option.none(),
	})

const PLOT_INSET = 8
const CENTER_TOTAL_MIN_INNER_R = 18

/** `resolveInnerRadius` for a donut (definitions/pie.ts, kept out of the view's imports). */
const holeRadiusOf = (outerRadius: number, innerRadius: number | undefined): number =>
	Math.max(8, Math.min(outerRadius - 6, innerRadius ?? outerRadius * 0.58))

/** `fmtCenterTotal`: small integers spelled out, the rest formatted like the slices. */
const fmtCenterTotal = (value: number, unit: string | undefined): string =>
	(unit === undefined || unit === "") && Number.isInteger(value) && Math.abs(value) < 10_000
		? value.toLocaleString("en-US")
		: fmtValue(value, unit)

/** `DonutCenterTotal`: the total in the hole once the plot rect is known and the hole holds it. */
const donutCenterTotal = (
	h: ChartViewBuilder,
	model: Model,
	total: number,
	unit: string | undefined,
	innerRadius: number | undefined,
): Html =>
	Option.match(model.plot, {
		onNone: () => h.empty,
		onSome: (rect) => {
			const holeRadius = holeRadiusOf(Math.min(rect.width, rect.height) / 2 - PLOT_INSET, innerRadius)
			if (holeRadius <= CENTER_TOTAL_MIN_INNER_R) return h.empty
			return h.div(
				[
					h.Class(
						"absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center leading-none",
					),
					h.Style({ left: `${rect.x + rect.width / 2}px`, top: `${rect.y + rect.height / 2}px` }),
				],
				[
					h.span(
						[
							h.Class("font-semibold text-foreground tabular-nums"),
							h.Style({
								"font-size": `${Math.min(22, holeRadius * 0.6)}px`,
								"letter-spacing": "-0.02em",
							}),
						],
						[fmtCenterTotal(total, unit)],
					),
					h.span(
						[
							h.Class("pt-1 text-muted-foreground uppercase"),
							h.Style({
								"font-size": `${Math.min(10, holeRadius * 0.28)}px`,
								"letter-spacing": "0.04em",
							}),
						],
						["total"],
					),
				],
			)
		},
	})

export const view = ChartBlock.makeView.withInputs<PieChartInputs>((model, inputs, h) => {
	const { rows, colorTokens, total } = pieRowsOf(inputs.data)
	const { unit } = inputs
	const background = resolveColor(inputs.theme, "--background")
	const pieRows: ReadonlyArray<PieSliceRow> = rows.map((row) => ({
		...row,
		color: resolveColor(inputs.theme, colorTokens.get(row.name) ?? OTHER_COLOR, SLICE_FALLBACK),
	}))

	if (rows.length === 0 || total <= 0) {
		return h.div(
			[
				h.Class(cn("relative grid h-full w-full place-items-center", inputs.className)),
				h.OnMount(MeasureChartContainer()),
			],
			[h.span([h.Class("text-2xs text-muted-foreground")], ["No data"])],
		)
	}

	const showLegend = inputs.legend !== "hidden"
	const tableLegendW = clamp(
		Math.round(model.containerWidth * TABLE_LEGEND_RATIO),
		TABLE_LEGEND_MIN_W,
		TABLE_LEGEND_MAX_W,
	)
	const tableLegend =
		showLegend && inputs.legend === "right" && model.containerWidth - tableLegendW >= TABLE_MIN_PIE_W
	const chipLegend = showLegend && !tableLegend

	const series: ReadonlyArray<PlotLegendSeries> = pieRows.map((row) => ({
		key: row.name,
		label: row.collapsedCount ? `${row.name} +${row.collapsedCount}` : row.name,
		color: row.color,
		// Figures only in the side table: the bottom chips are a colour key.
		value: tableLegend ? fmtValue(row.value, unit) : undefined,
		secondary: tableLegend ? (total > 0 ? formatPercent(row.value / total) : EMPTY_VALUE) : undefined,
	}))
	const legendState = {
		series,
		highlighted: model.highlightedKey,
		active: model.activeKey,
		label: LEGEND_LABEL,
	}

	const statsTable = h.div(
		[h.Style({ width: `${tableLegendW}px`, "max-width": "100%" })],
		Option.toArray(statsLegend(h, legendState)),
	)
	const legend = tableLegend
		? statsTable
		: chipLegend
			? legendRow(h, legendState, CHIP_STRIP_CLASS)
			: undefined

	return h.div(
		[
			h.Class(cn("flex h-full w-full flex-col select-none", inputs.className)),
			h.OnMount(MeasureChartContainer()),
		],
		[
			plotFrame(h, {
				chartId: inputs.chartId,
				className: "min-h-12 min-w-0 flex-1",
				ariaLabel: LEGEND_LABEL,
				spec: ChartSpec.Pie({
					rows: pieRows,
					activeName: Option.getOrNull(model.activeKey),
					highlighted: Option.getOrNull(model.highlightedKey),
					background,
					donut: inputs.donut === true,
					innerRadius: inputs.innerRadius ?? null,
					showLabels: inputs.showLabels ?? false,
					showPercent: inputs.showPercent ?? true,
					unit: unit ?? null,
					showTooltip: inputs.tooltip !== "hidden",
				}),
				legend,
				legendPlacement: tableLegend ? "right" : "bottom",
				...(inputs.donut === true
					? {
							reportPlot: true,
							overlay: donutCenterTotal(h, model, total, unit, inputs.innerRadius),
						}
					: undefined),
				tooltipBody: (portal) =>
					Option.flatMap(model.tooltip, (tooltip) => tooltipBody(h, tooltip, unit, portal)),
			}),
		],
	)
})
