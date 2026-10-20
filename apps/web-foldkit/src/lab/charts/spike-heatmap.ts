import { createSequentialColorScale } from "@maple/ui/components/plot/color-scale"
import { formatNumber } from "@maple/ui/lib/format"
import { cell, type ChartPoint, type ChartValue, defineChart } from "@tanstack/charts"
import { colorGradientLegend } from "@tanstack/charts/legend"
import { tooltip } from "@tanstack/charts/tooltip"
import { scaleBand } from "@tanstack/charts-scales/band"
import { Option } from "effect"
import { ChartTooltip } from "../../charts/chart-spec"
import type { BuiltChart } from "../../charts/definitions/built-chart"
import {
	HEATMAP_SPIKE_ROWS,
	type HeatmapHole,
	type HeatmapSpikeRow,
	heatmapSpikeModel,
} from "./spike-heatmap-model"
import type { SpikeSpec } from "./spike-spec"
import { RAMP_TOKENS } from "./spike-timeseries-tokens"

// `HeatmapSpike`, definition half: grout cells for the
// holes, value cells on a sequential scale, a gradient legend. Code copied, constants unchanged.

type Slot = HeatmapSpikeRow | HeatmapHole
type Point = ChartPoint<Slot, ChartValue, ChartValue>

export const buildHeatmapSpike = (spec: SpikeSpec): BuiltChart<Slot, ChartValue, ChartValue> => {
	const model = heatmapSpikeModel(HEATMAP_SPIKE_ROWS)
	const grout = spec.colors["--heatmap-grout"] ?? ""
	const foreground = spec.colors["--foreground"] ?? ""
	const colorScale = createSequentialColorScale({
		stops: RAMP_TOKENS.amber.map(([token]) => spec.colors[token] ?? ""),
		domain: model.domain,
		scaleType: "linear",
	})
	const { radius, inset, padding } = model.geometry
	const holes = cell(model.holes, {
		x: (hole: HeatmapHole) => hole.x,
		y: (hole: HeatmapHole) => hole.y,
		fill: grout,
		inset,
		radius,
	})
	const data = cell(model.visibleRows, {
		x: (row: HeatmapSpikeRow) => row.x,
		y: (row: HeatmapSpikeRow) => row.y,
		color: (row: HeatmapSpikeRow) => row.value,
		inset,
		radius,
		states: [
			{ when: { focus: "unmatched" }, style: { opacity: 0.28 } },
			{ when: { focus: "x" }, style: { opacity: 1 } },
			{ when: { focus: "y" }, style: { opacity: 1 } },
			{ when: { focus: "primary" }, style: { stroke: foreground, strokeWidth: 1.5 } },
		],
	})
	const definition = defineChart({
		marks: [holes, data],
		scales: {
			x: { scale: scaleBand<string>([...model.xDomain], [0, 1]).paddingInner(padding), grid: false },
			y: { scale: scaleBand<string>([...model.yDomain], [0, 1]).paddingInner(padding), grid: false },
		},
		color: {
			scale: colorScale,
			legend: colorGradientLegend({
				label: "Count",
				placement: "bottom",
				format: (value) => formatNumber(Math.round(value)),
			}),
		},
		focus: "nearest",
		focusRing: false,
		tooltip: { use: tooltip, className: "maple-plot-tooltip" },
	})
	return {
		definition,
		focusKeyOf: (point) => `${point.datum.x}:${point.datum.y}`,
		tooltipOf: (points: ReadonlyArray<Point>) =>
			Option.map(Option.fromNullishOr(points[0]?.datum), (slot) =>
				ChartTooltip.HeatmapSlot({
					x: slot.x,
					y: slot.y,
					value: "value" in slot ? slot.value : null,
				}),
			),
	}
}
