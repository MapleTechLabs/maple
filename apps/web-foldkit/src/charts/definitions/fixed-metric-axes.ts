import type { ChartLinearGradient } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { hasOnlyIntegerValues } from "@maple/ui/components/charts/_shared/sparse-series"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import {
	NICE_TICK_COUNT,
	integerTickValues,
	linearYDomain,
	niceLinearDomain,
	zonedTimeScale,
} from "@maple/ui/components/plot/plot-scales"
import { formatBucketLabel, formatValueByUnit } from "@maple/ui/lib/format"
import type { TimeseriesAxisContext } from "../fixed-metric-series"

// copied: the axis builders of packages/ui/src/components/plot/timeseries.tsx and plot-paint.ts
// (their modules import React).

/** `timeseriesXAxis`: zoned time ticks, 104 px candidate spacing, edge labels anchored inward. */
export const timeseriesXAxis = (axisContext: TimeseriesAxisContext) => ({
	scale: zonedTimeScale(axisContext.timeZone),
	axis: {
		line: false,
		ticks: {
			size: 0,
			padding: 8,
			spacing: 104,
			format: (value: Date) => formatBucketLabel(value.toISOString(), axisContext, "tick"),
		},
		tickLabels: { thin: { minGap: 12 }, anchor: edgeTickAnchor(axisContext) },
	},
})

const NOMINAL_PLOT_WIDTH = 600
const HALF_CHAR_PX = 2.8
const MAX_EDGE_FRACTION = 0.2

function edgeTickAnchor(axisContext: TimeseriesAxisContext) {
	const domain = axisContext.domainMs
	if (!domain) return undefined
	const spanMs = domain[1] - domain[0]
	if (spanMs <= 0) return undefined
	return ({ value }: { value: Date }): "start" | "middle" | "end" => {
		const at = value.getTime()
		if (!Number.isFinite(at)) return "middle"
		const label = formatBucketLabel(value.toISOString(), axisContext, "tick")
		const fraction = Math.min(MAX_EDGE_FRACTION, (label.length * HALF_CHAR_PX) / NOMINAL_PLOT_WIDTH)
		const slackMs = spanMs * fraction
		if (at >= domain[1] - slackMs) return "end"
		if (at <= domain[0] + slackMs) return "start"
		return "middle"
	}
}

export interface TimeseriesYAxisOptions {
	readonly rows: ReadonlyArray<Record<string, unknown>>
	readonly visibleKeys: ReadonlyArray<string>
	readonly softMin?: number
	readonly softMax?: number
	readonly format?: (value: number) => string
}

/** `timeseriesYAxis` for the linear, unstacked case the fixed-metric charts use. */
export const timeseriesYAxis = (options: TimeseriesYAxisOptions) => {
	const { rows, visibleKeys, softMin, softMax, format } = options
	const dataDomain = linearYDomain({ rows, keys: visibleKeys, softMin, softMax })
	const domain: [number, number] = niceLinearDomain(dataDomain)
	const integerOnly = hasOnlyIntegerValues(rows, visibleKeys) && format == null
	return {
		domain,
		y: {
			grid: DASHED_Y_GRID,
			scale: scaleLinear().domain(domain),
			nice: NICE_TICK_COUNT,
			axis: {
				line: false,
				ticks: {
					size: 0,
					padding: 6,
					values: integerOnly ? integerTickValues(domain) : undefined,
					format: format ?? ((value: number) => formatValueByUnit(value, undefined)),
				},
			},
		},
	}
}

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
