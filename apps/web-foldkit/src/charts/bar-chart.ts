import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Attribute, Html } from "foldkit/html"
import type { Message, Model } from "./chart"
import { ChartSpec, ChartTooltip } from "./chart-spec"
import { bucketTooltipBody } from "./bucket-tooltip"
import { plotFrame } from "./plot-frame"
import { resolveColor, type ThemeColors } from "./theme-colors"
import { SERIES_FALLBACK_COLOR, seriesColorTokens, seriesDefinitionsOf } from "./timeseries"

// Port of `QueryBuilderBarChart` + `Timeseries.Frame` (packages/ui/src/components/charts/bar/,
// plot/timeseries.tsx) with the legend hidden; the definition is `definitions/bar.ts`.
// TODO(bar-legend): `legend="visible"`/`"right"` and the series stats table are not ported.

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
	/** The clock the in-flight tail is judged against (`Date.now()` in the React chart). */
	readonly nowMs: number
	readonly stacked?: boolean
	readonly className?: string
	readonly showTooltip?: boolean
}

export const view = Submodel.defineView<Model, Message, BarChartInputs>((model, inputs, h) => {
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
	const tooltipBody = (portal: Attribute<Message>): Option.Option<Html> =>
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
		[h.Class(cn("h-full w-full", inputs.className))],
		[
			plotFrame(h, {
				chartId: inputs.chartId,
				className: "h-full w-full",
				ariaLabel: "Time series",
				spec: ChartSpec.QueryBuilderBar({
					data: inputs.data,
					colors,
					fallbackColor: SERIES_FALLBACK_COLOR,
					unit: inputs.unit ?? null,
					timeZone: inputs.timeZone ?? null,
					nowMs: inputs.nowMs,
					stacked: inputs.stacked ?? false,
					showTooltip: inputs.showTooltip ?? true,
				}),
				// A hidden legend still leaves `PlotFrame` its (empty) legend element.
				legend: h.empty,
				tooltipBody,
			}),
		],
	)
})
