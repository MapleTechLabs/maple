import type { ChartGuideLineStyle } from "@tanstack/charts"

/**
 * Horizontal grid lines at the y axis' ticks, dashed.
 *
 * The dash is the Recharts `CartesianGrid` one (`vertical={false}`,
 * `strokeDasharray="3 3"`), and it is all this carries: `grid` took a
 * `ChartGuideLineStyle` in 0.18, and an omitted field keeps the theme's own grid
 * paint. This replaced `dashedGridY()`, a `createMark` workaround from when
 * `grid` was a `boolean` and nothing anywhere could dash it.
 *
 * The style lands on each RULE, not on the `.ts-chart__grid` group — the group
 * keeps the theme defaults, which is the opposite of where the mark put it.
 */
export const DASHED_Y_GRID: ChartGuideLineStyle = {
	strokeDasharray: "3 3",
}
