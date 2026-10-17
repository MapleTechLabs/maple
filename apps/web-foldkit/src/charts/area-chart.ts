import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import type { Message, Model } from "./chart"
import { MeasureChartContainer } from "./chart-mounts"
import { ChartSpec, ChartTooltip } from "./chart-spec"
import { plotFrame } from "./plot-frame"
import { resolveColor, type ThemeColors } from "./theme-colors"
import { SERIES_FALLBACK_COLOR, seriesColorTokens, seriesDefinitionsOf } from "./timeseries"

// Port of `QueryBuilderAreaChart` + `Timeseries.Frame` (packages/ui/src/components/charts/area/,
// plot/timeseries.tsx) for an unstacked chart whose legend is hidden or absent.
// TODO(legend): `legend="visible"|"right"` (`QueryBuilderLegend`, series toggles, stats) is not ported.

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
}

/** `PlotTooltipBody` for one bucket: the heading, then a swatch, label and value per series. */
const tooltipBody = (
	h: HtmlBuilder<Message>,
	tooltip: ChartTooltip,
	portal: Attribute<Message>,
): Option.Option<Html> =>
	ChartTooltip.match(tooltip, {
		TimeseriesBucket: (bucket) =>
			Option.some(
				h.div(
					[h.Class("grid min-w-[9rem] max-w-[22rem] items-start gap-1.5"), portal],
					[
						h.div(
							[
								h.Class(
									"border-border/50 border-b pb-1 font-medium text-muted-foreground tracking-tight",
								),
							],
							[bucket.heading],
						),
						h.div(
							[h.Class("grid gap-1.5")],
							bucket.rows.map((row) =>
								h.div(
									[h.Class("flex w-full items-center gap-2")],
									[
										h.span([
											h.Class("size-2.5 shrink-0 rounded-xs"),
											h.Style({ "background-color": row.color }),
										]),
										h.div(
											[
												h.Class(
													"flex flex-1 items-center justify-between gap-3 leading-none",
												),
											],
											[
												h.span(
													[
														h.Class("min-w-0 truncate text-muted-foreground"),
														h.Title(row.label),
													],
													[row.label],
												),
												h.span(
													[
														h.Class(
															"shrink-0 font-mono font-semibold text-foreground tabular-nums",
														),
													],
													[row.value],
												),
											],
										),
									],
								),
							),
						),
					],
				),
			),
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
				}),
				// `TimeseriesLegend` in its hoisting mode renders nothing, but `PlotFrame` still gets an element.
				legend: h.empty,
				tooltipBody: (portal) =>
					Option.flatMap(model.tooltip, (tooltip) => tooltipBody(h, tooltip, portal)),
			}),
		],
	)
})
