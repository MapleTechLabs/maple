import type { Html, HtmlBuilder } from "foldkit/html"
import { type FixedMetricSeries, LATENCY_SERIES } from "./fixed-metric-series"
import { resolveColor, type ThemeColors } from "./theme-colors"
import { swatch } from "../ui/swatch"
import { Array as Arr } from "effect"
import { hstack } from "../ui/stack"
import { typography } from "../ui/typography"

// Port of `FixedMetricLegend` (packages/ui/src/components/plot/fixed-metrics.tsx).

/** `FixedMetricLegend`: the always-on swatch strip; items match the widget header legend. */
export const fixedMetricLegend = <M>(h: HtmlBuilder<M>, series: ReadonlyArray<FixedMetricSeries>): Html =>
	hstack(
		h,
		{ align: "stretch", wrap: true, className: "gap-x-3 gap-y-0.5 pt-2 text-xs" },
		Arr.map(series, (entry) =>
			hstack(
				h,
				{
					gap: "1.5",
					align: "center",
					shrink: true,
					as: "span",
					className: "text-foreground",
					attributes: [h.Key(entry.key)],
				},
				[
					swatch(h, { color: entry.color, dashed: entry.dashed }),
					typography(h, { truncate: true }, [entry.label]),
				],
			),
		),
	)

/** The P99/P95/P50 series `LatencyLineChart` draws, coloured off the theme. */
export const latencySeries = (theme: ThemeColors): ReadonlyArray<FixedMetricSeries> =>
	Arr.map(LATENCY_SERIES, (entry) => ({
		key: entry.key,
		label: entry.label,
		color: resolveColor(theme, entry.token),
	}))
