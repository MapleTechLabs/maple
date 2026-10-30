import type { ChartLinearGradient } from "@tanstack/charts"

// copied: the paint helpers of packages/ui/src/components/plot/plot-paint.ts (its module imports
// React). The axes are in `../timeseries`.

/** Every primary series line draws at this weight; secondary and reference lines go thinner. */
export const SERIES_STROKE_WIDTH = 1.5

/** The wash under a line: soft at the top and gone by the baseline, so the line carries the value. */
export const AREA_FILL_START = 0.24
/** Not 0: a 0% stop resolves to transparent black, and the canvas fades the wash through grey. */
export const AREA_FILL_END = 0.01

/** `verticalGradient` (plot-paint.ts). */
export const verticalGradient = (
	id: string,
	color: string,
	startOpacity = AREA_FILL_START,
	endOpacity = AREA_FILL_END,
): ChartLinearGradient => ({
	id,
	x1: 0,
	y1: 0,
	x2: 0,
	y2: 1,
	stops: [
		{ offset: 0.05, color, opacity: startOpacity },
		{ offset: 0.95, color, opacity: endOpacity },
	],
})

/** `roundCapDasharray` (plot-paint.ts): the round cap moves from the dash into the gap. */
export const roundCapDasharray = (on: number, off: number, strokeWidth: number): string =>
	`${Math.max(0.01, on - strokeWidth)} ${off + strokeWidth}`
