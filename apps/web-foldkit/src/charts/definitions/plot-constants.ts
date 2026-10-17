import type { ChartTooltipAnchor, ChartValue } from "@tanstack/charts"
import { tooltip } from "@tanstack/charts/tooltip"

// Copied from React modules of packages/ui/src/components/plot (plot-tooltip.tsx, plot-legend.tsx,
// plot-frame.tsx) so this file stays React-free. Phase 1 moves them to a shared module.

/** `cursorTooltip` (plot-tooltip.tsx): the shell themed by plot-tooltip.css, beside the cursor. */
export const cursorTooltip = <TDatum>(anchor: ChartTooltipAnchor<TDatum, ChartValue, number> | "pointer") =>
	({
		use: tooltip,
		className: "maple-plot-tooltip",
		anchor,
		placement: "right",
		offset: 12,
	}) as const

/** plot-legend.tsx: how far a non-highlighted series' colour is mixed into the background. */
export const MUTED_COLOR_AMOUNT = 0.78

/** plot-frame.tsx: `maxFocusDistance` for a chart that resolves focus anywhere in the plot. */
export const UNBOUNDED_FOCUS_DISTANCE = Number.MAX_SAFE_INTEGER
