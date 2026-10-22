import { createSequentialColorScale } from "@maple/ui/components/plot/color-scale"
import { cell, defineChart, type ChartPoint } from "@tanstack/charts"
import { scaleBand } from "@tanstack/charts-scales/band"
import { tooltip } from "@tanstack/charts/tooltip"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"

// The `definition` memo of `QueryBuilderHeatmapChart` (packages/ui/src/components/charts/heatmap/
// query-builder-heatmap-chart.tsx): grout holes under the coloured cells, one hover cascade for both.

type HeatmapSpec = Extract<ChartSpec, { readonly _tag: "Heatmap" }>
type Slot = HeatmapSpec["cells"][number]

const UNMATCHED_OPACITY = 0.28

const slotTooltip = (points: ReadonlyArray<ChartPoint<Slot, string, string>>): Option.Option<ChartTooltip> =>
	Option.map(Option.fromNullishOr(points[0]?.datum), (slot) =>
		ChartTooltip.HeatmapSlot({ x: slot.x, y: slot.y, value: slot.value }),
	)

export const buildHeatmap = (spec: HeatmapSpec): BuiltChart<Slot, string, string> => {
	const colors = createSequentialColorScale({
		stops: spec.stops,
		domain: spec.domain,
		scaleType: spec.scaleType,
	})
	const focusStates = [
		{ when: { focus: "unmatched" }, style: { opacity: UNMATCHED_OPACITY } },
		{ when: { focus: "x" }, style: { opacity: 1 } },
		{ when: { focus: "y" }, style: { opacity: 1 } },
		{ when: { focus: "primary" }, style: { stroke: spec.foreground, strokeWidth: 1.5 } },
	] as const
	const holes = cell(spec.holes, {
		x: (slot: Slot) => slot.x,
		y: (slot: Slot) => slot.y,
		fill: spec.grout,
		radius: spec.radius,
		states: focusStates,
	})
	const cells = cell(spec.cells, {
		x: (slot: Slot) => slot.x,
		y: (slot: Slot) => slot.y,
		color: (slot: Slot) => slot.value,
		radius: spec.radius,
		states: focusStates,
	})
	return {
		definition: defineChart({
			marks: [holes, cells],
			margin: spec.margin ?? undefined,
			scales: {
				x: {
					scale: scaleBand<string>([...spec.xDomain], [0, 1]).paddingInner(spec.paddingInnerX),
					grid: false,
					axis: { line: false, ticks: { size: 0, padding: 6 } },
				},
				y: {
					scale: scaleBand<string>([...spec.yDomain], [0, 1]).paddingInner(spec.paddingInnerY),
					grid: false,
					axis: {
						line: false,
						ticks: {
							size: 0,
							padding: 6,
							format: (value: string) => spec.yLabels[value] ?? value,
						},
						tickLabels: { thin: { priority: "ends" } },
					},
				},
			},
			color: { scale: colors },
			focus: "nearest",
			focusRing: false,
			tooltip: spec.showTooltip
				? {
						use: tooltip,
						className: "maple-plot-tooltip",
						anchor: "point",
						placement: "top",
						offset: 6,
					}
				: false,
		}),
		focusKeyOf: (point) => `${point.datum.x}\u0000${point.datum.y}`,
		tooltipOf: slotTooltip,
	}
}
