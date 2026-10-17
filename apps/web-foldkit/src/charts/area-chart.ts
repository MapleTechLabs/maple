import { findFirstPartialIndex } from "@maple/ui/components/plot/partial-buckets"
import { computeSeriesStats, sortZeroSeriesLast } from "@maple/ui/components/plot/series-stats"
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
// TODO(legend): `legend="right"` and the `seriesStats` table variant are not ported.

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
		return compactLegend(h, sortZeroSeriesLast(series, stats), model.hiddenKeys)
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
				}),
				// A hoisting `TimeseriesLegend` renders nothing, but `PlotFrame` still gets an element.
				legend,
				tooltipBody: (portal) =>
					Option.flatMap(model.tooltip, (tooltip) => tooltipBody(h, tooltip, portal)),
			}),
		],
	)
})
