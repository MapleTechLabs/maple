import type { ChartLinearGradient } from "@tanstack/charts"

// copied: the paint helpers of packages/ui/src/components/plot/plot-paint.ts (its module imports
// React). The axes are in `../timeseries`.

/** `verticalGradient` (plot-paint.ts). */
export const verticalGradient = (
	id: string,
	color: string,
	startOpacity = 0.8,
	endOpacity = 0.1,
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
