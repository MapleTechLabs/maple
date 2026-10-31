import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type FixedMetricSeries, LATENCY_SERIES } from "./fixed-metric-series"
import { resolveColor, type ThemeColors } from "./theme-colors"

// Port of `FixedMetricLegend` (packages/ui/src/components/plot/fixed-metrics.tsx).

/** `FixedMetricLegend`: the always-on swatch strip; items match the widget header legend. */
export const fixedMetricLegend = <M>(h: HtmlBuilder<M>, series: ReadonlyArray<FixedMetricSeries>): Html =>
	h.div(
		[h.Class("flex flex-wrap gap-x-3 gap-y-0.5 pt-2 text-xs")],
		series.map((entry) =>
			h.span(
				[h.Key(entry.key), h.Class("flex min-w-0 items-center gap-1.5 text-foreground")],
				[
					h.span([
						h.Class(
							cn("size-2 shrink-0 rounded-xs", entry.dashed === true && "border border-dashed"),
						),
						h.Style(
							entry.dashed === true
								? { "border-color": entry.color }
								: { "background-color": entry.color },
						),
					]),
					h.span([h.Class("truncate")], [entry.label]),
				],
			),
		),
	)

/** The P99/P95/P50 series `LatencyLineChart` draws, coloured off the theme. */
export const latencySeries = (theme: ThemeColors): ReadonlyArray<FixedMetricSeries> =>
	LATENCY_SERIES.map((entry) => ({
		key: entry.key,
		label: entry.label,
		color: resolveColor(theme, entry.token),
	}))
