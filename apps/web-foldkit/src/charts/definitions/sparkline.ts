import { areaY, defineChart, lineY, type ChartLinearGradient } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { Option } from "effect"
import type { ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"

// Port of `PlotSparkline` (packages/ui/src/components/plot/sparkline.tsx), definition half.
// TODO(monotone): `curve="monotone"` (the stat widget) needs d3-shape as a dependency.

type SparklineSpec = Extract<ChartSpec, { readonly _tag: "Sparkline" }>

interface SparkPoint {
	readonly index: number
	readonly value: number
}

const STROKE_WIDTH = 1.5

// copied: `verticalGradient` (plot-paint.ts imports React's `useId`).
const verticalGradient = (
	id: string,
	color: string,
	startOpacity: number,
	endOpacity: number,
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

export const buildSparkline = (spec: SparklineSpec): BuiltChart<SparkPoint, number, number> => {
	const points: ReadonlyArray<SparkPoint> = spec.values.map((value, index) => ({ index, value }))
	const at = (point: SparkPoint) => point.index
	const value = (point: SparkPoint) => point.value
	const definition = defineChart({
		gradients: [verticalGradient(spec.gradientId, spec.color, spec.fillStart, spec.fillEnd)],
		marks: [
			areaY(points, {
				x: at,
				y: value,
				y1: () => 0,
				fill: `url(#${spec.gradientId})`,
				stroke: "none",
			}),
			lineY(points, { x: at, y: value, stroke: spec.color, strokeWidth: STROKE_WIDTH }),
		],
		scales: {
			x: { scale: scaleLinear, axis: false },
			y: { scale: scaleLinear, axis: false },
		},
		tooltip: false,
		focus: false,
		margin: { top: 2, right: 0, bottom: 0, left: 0 },
	})
	return { definition, focusKeyOf: (point) => String(point.datum.index), tooltipOf: () => Option.none() }
}
