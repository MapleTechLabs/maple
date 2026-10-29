import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html } from "foldkit/html"
import { type ChartAttribute, ChartBlock } from "./chart"
import { MeasureChartContainer } from "./chart-mounts"
import { timeseriesLegend } from "./timeseries-legend"
import {
	bucketTimeseries,
	MAX_BAR_SERIES,
	OTHER_LABEL,
} from "@maple/ui/components/charts/_shared/bucket-series"
import { ChartSpec, ChartTooltip, type TimeseriesAxisSpec } from "./chart-spec"
import { bucketTooltipBody } from "./bucket-tooltip"
import { plotFrame } from "./plot-frame"
import { resolveColor, type ThemeColors } from "./theme-colors"
import { SERIES_FALLBACK_COLOR, seriesColorTokens, seriesDefinitionsOf } from "./timeseries"

// Port of `QueryBuilderBarChart` + `Timeseries.Frame` (packages/ui/src/components/charts/bar/,
// plot/timeseries.tsx): the long tail folded into "Other", and its legend; the definition is
// `definitions/bar.ts`.

/** The tokens the bar series can resolve to; a page reads them with `ResolveThemeColors`. */
export const BAR_CHART_TOKENS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
	"var(--muted-foreground)",
]

export interface BarChartInputs {
	readonly chartId: string
	readonly data: ReadonlyArray<Readonly<Record<string, string | number | boolean>>>
	readonly theme: ThemeColors
	readonly unit?: string | undefined
	readonly timeZone?: string | undefined
	/** The clock the in-flight tail is judged against. */
	readonly nowMs: number
	readonly stacked?: boolean
	readonly className?: string
	readonly showTooltip?: boolean
	readonly axis?: TimeseriesAxisSpec | undefined
	readonly legend?: "hidden" | "visible" | "right" | undefined
	readonly seriesStats?: boolean
}

type Row = Readonly<Record<string, string | number | boolean>>

/** `bucketBarSeries`: past `MAX_BAR_SERIES` the long tail folds into one "Other" series. */
export const bucketBarSeries = (data: ReadonlyArray<Row>): ReadonlyArray<Row> => {
	const seriesKeys = [
		...new Set(
			data.flatMap((row) => Object.keys(row).filter((key) => key !== "bucket" && key !== "partial")),
		),
	]
	if (seriesKeys.length <= MAX_BAR_SERIES) return data
	const { rows } = bucketTimeseries(data, seriesKeys, MAX_BAR_SERIES)
	return rows.map((row, index) => (data[index]?.partial === true ? { ...row, partial: true } : row))
}

export const view = ChartBlock.makeView.withInputs<BarChartInputs>((model, inputs, h) => {
	const data = bucketBarSeries(inputs.data)
	const { definitions } = seriesDefinitionsOf(data)
	const tokens = seriesColorTokens(definitions)
	const otherColor = resolveColor(inputs.theme, "--muted-foreground")
	const colors = Object.fromEntries(
		definitions.map((definition) => [
			definition.chartKey,
			definition.rawKey === OTHER_LABEL
				? otherColor
				: resolveColor(
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
	const tooltipBody = (portal: ChartAttribute): Option.Option<Html> =>
		Option.flatMap(model.tooltip, (tooltip) =>
			ChartTooltip.match(tooltip, {
				Bucket: (bucket) => Option.some(bucketTooltipBody(h, bucket, portal)),
				PieSlice: () => Option.none(),
				NumericBin: () => Option.none(),
				CategoricalBin: () => Option.none(),
				HeatmapSlot: () => Option.none(),
			}),
		)
	return h.div(
		[h.Class(cn("h-full w-full", inputs.className)), h.OnMount(MeasureChartContainer())],
		[
			plotFrame(h, {
				chartId: inputs.chartId,
				className: "h-full w-full",
				ariaLabel: "Time series",
				spec: ChartSpec.QueryBuilderBar({
					data,
					colors,
					fallbackColor: SERIES_FALLBACK_COLOR,
					unit: inputs.unit ?? null,
					timeZone: inputs.timeZone ?? null,
					nowMs: inputs.nowMs,
					stacked: inputs.stacked ?? false,
					showTooltip: inputs.showTooltip ?? true,
					...(inputs.axis === undefined ? undefined : { axis: inputs.axis }),
				}),
				legend: timeseriesLegend(h, model, {
					series,
					data,
					definitions,
					unit: inputs.unit,
					nowMs: inputs.nowMs,
					legend: inputs.legend,
					seriesStats: inputs.seriesStats === true,
				}),
				legendPlacement: inputs.legend === "right" ? "right" : "bottom",
				tooltipBody,
			}),
		],
	)
})
