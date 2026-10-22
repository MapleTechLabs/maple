import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { Message, type Model } from "./chart"
import { MeasureChartContainer } from "./chart-mounts"
import { ChartSpec, ChartTooltip, type TimeseriesAxisSpec } from "./chart-spec"
import { bucketTooltipBody } from "./bucket-tooltip"
import { plotFrame } from "./plot-frame"
import { resolveColor, type ThemeColors } from "./theme-colors"
import { SERIES_FALLBACK_COLOR, seriesColorTokens, seriesDefinitionsOf } from "./timeseries"
import { timeseriesLegend } from "./timeseries-legend"

// Port of `QueryBuilderAreaChart` + `Timeseries.Frame` (packages/ui/src/components/charts/area/,
// plot/timeseries.tsx) with a hidden, bottom or right legend.
// TODO(legend): the hoisted header legend is not ported.

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
	/** The clock the in-flight tail is judged against. */
	readonly nowMs: number
	readonly className?: string
	readonly showTooltip?: boolean
	/** `visible` under the plot, `right` beside it; otherwise the legend hoists (nothing here). */
	readonly legend?: "hidden" | "visible" | "right"
	/** `QueryBuilderLineChart`: lines instead of bands. */
	readonly mark?: "area" | "line"
	readonly stacked?: boolean
	readonly curveType?: "linear" | "monotone"
	readonly showPoints?: boolean
	/** `seriesStats`: the visible legend is the Min/Max/Mean/Last table. */
	readonly seriesStats?: boolean
	/** Thresholds, log scale and soft bounds (`QueryBuilderAreaChart`'s cartesian props). */
	readonly axis?: TimeseriesAxisSpec | undefined
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
		HeatmapSlot: () => Option.none(),
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
	const legend = timeseriesLegend(h, model, {
		series,
		data: inputs.data,
		definitions,
		unit: inputs.unit,
		nowMs: inputs.nowMs,
		legend: inputs.legend,
		seriesStats: inputs.seriesStats === true,
	})
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
					...(inputs.axis === undefined ? undefined : { axis: inputs.axis }),
				}),
				// A hoisting `TimeseriesLegend` renders nothing, but `PlotFrame` still gets an element.
				legend,
				legendPlacement: inputs.legend === "right" ? "right" : "bottom",
				tooltipBody: (portal) =>
					Option.flatMap(model.tooltip, (tooltip) => tooltipBody(h, tooltip, portal)),
			}),
		],
	)
})
