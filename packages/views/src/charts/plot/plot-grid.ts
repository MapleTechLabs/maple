import type { ChartGuideLineStyle } from "@tanstack/charts"

/**
 * Horizontal grid lines at the y axis' ticks: solid hairlines, quieter than the theme's own.
 *
 * Solid because a dashed rule is the busiest thing in a plot that holds one line; the opacity is
 * under the theme's 0.11, which was tuned for dashes that paint half the ink.
 *
 * The style lands on each RULE, not on the `.ts-chart__grid` group, which keeps the
 * theme defaults.
 */
export const Y_GRID: ChartGuideLineStyle = {
	strokeOpacity: 0.075,
}
