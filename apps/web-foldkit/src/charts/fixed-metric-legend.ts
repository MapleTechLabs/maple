import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type FixedMetricSeries, LATENCY_SERIES } from "./fixed-metric-series"
import { resolveColor, type ThemeColors } from "./theme-colors"

// Port of `FixedMetricLegend` (packages/ui/src/components/plot/fixed-metrics.tsx) and
// `LinkedCursorOverlay` (apps/web/src/hooks/use-linked-cursor.tsx).

/** `FixedMetricLegend`: the always-on swatch strip under a fixed-metric plot. */
export const fixedMetricLegend = <M>(h: HtmlBuilder<M>, series: ReadonlyArray<FixedMetricSeries>): Html =>
	h.div(
		[h.Class("flex flex-wrap gap-x-3 gap-y-0.5 pt-2 text-xs")],
		series.map((entry) =>
			h.span(
				[h.Key(entry.key), h.Class("flex items-center gap-1.5 px-1 py-0.5")],
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

/** `LinkedCursorOverlay`: the shared hover cursor, hidden until a sibling chart is hovered. */
export const linkedCursorOverlay = <M>(h: HtmlBuilder<M>, id: string): Html =>
	h.div(
		[
			h.AriaHidden(true),
			h.Class("pointer-events-none absolute"),
			h.DataAttribute("linked-cursor-overlay", id),
			h.Style({ "container-type": "inline-size", opacity: "var(--linked-cursor-visible)" }),
		],
		[
			h.div([
				h.Class("absolute inset-y-0 left-0 w-px bg-muted-foreground/45 will-change-transform"),
				h.Style({ transform: "translateX(calc(var(--linked-cursor-ratio) * (100cqw - 1px)))" }),
			]),
		],
	)
