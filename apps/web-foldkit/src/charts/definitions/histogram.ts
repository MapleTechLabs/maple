import { formatNumber } from "@maple/ui/lib/format"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import {
	integerTickValues,
	logYScale,
	minBarLength,
	niceLinearDomain,
} from "@maple/ui/components/plot/plot-scales"
import { barY, defineChart, rect, type ChartPoint } from "@tanstack/charts"
import { binX } from "@tanstack/charts/transform/bin"
import { scaleBand } from "@tanstack/charts-scales/band"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scaleLog } from "d3-scale"
import { Option } from "effect"
import { ChartTooltip, type CategoricalBin, type ChartSpec, type NumericBin } from "../chart-spec"
import { binLowerBoundLabel, formatBound } from "../histogram-format"
import type { BuiltChart } from "./built-chart"
import { cursorTooltip, UNBOUNDED_FOCUS_DISTANCE } from "./plot-constants"

// Port of packages/ui/src/components/charts/histogram/query-builder-histogram-chart.tsx (definition
// half), plus the lab's binned histogram.

type NumericSpec = Extract<ChartSpec, { readonly _tag: "NumericHistogram" }>
type CategoricalSpec = Extract<ChartSpec, { readonly _tag: "CategoricalHistogram" }>
type BinnedSpec = Extract<ChartSpec, { readonly _tag: "BinnedHistogram" }>

const DIMMED_BIN_OPACITY = 0.5
const SPIKE_BIN_COUNT = 30

/** `useCountAxis`: the count axis shared by both production histogram shapes. */
const countAxis = (maxCount: number, useLogY: boolean) => {
	if (useLogY) {
		return {
			baseline: 1,
			liftCount: (value: number) => value,
			y: {
				grid: DASHED_Y_GRID,
				scale: logYScale(maxCount),
				axis: { line: false, ticks: { size: 0, padding: 6, format: formatNumber } },
			},
		}
	}
	const domain = niceLinearDomain([0, Math.max(maxCount, 1)])
	const ticks = integerTickValues(domain)
	const lift = minBarLength(domain)
	return {
		baseline: 0,
		liftCount: (value: number) => lift(value) ?? value,
		y: {
			grid: DASHED_Y_GRID,
			scale: scaleLinear().domain(domain),
			axis: { line: false, ticks: { size: 0, padding: 6, values: ticks, format: formatNumber } },
		},
	}
}

const binTooltip = <TDatum extends NumericBin, X extends number | string>(
	points: ReadonlyArray<ChartPoint<TDatum, X, number>>,
): Option.Option<ChartTooltip> =>
	Option.map(Option.fromNullishOr(points[0]?.datum), (bin) =>
		ChartTooltip.NumericBin({ x1: bin.x1, x2: bin.x2, value: bin.value }),
	)

/** `NumericHistogram`'s `definition` memo. */
export const buildNumericHistogram = (spec: NumericSpec): BuiltChart<NumericBin, number, number> => {
	const { bins, color, unit } = spec
	const maxCount = bins.reduce((max, bin) => Math.max(max, bin.value), 0)
	const { baseline, liftCount, y } = countAxis(maxCount, spec.useLogY)
	return {
		definition: defineChart({
			marks: [
				rect(bins, {
					x1: (bin: NumericBin) => bin.x1,
					x2: (bin: NumericBin) => bin.x2,
					y1: () => baseline,
					y2: (bin: NumericBin) => Math.max(liftCount(bin.value), baseline),
					fill: color,
					fillOpacity: 1,
					inset: 0.5,
					radius: 2,
					states: [{ when: { focus: "unmatched" }, style: { fillOpacity: DIMMED_BIN_OPACITY } }],
				}),
			],
			scales: {
				x: {
					scale: scaleLinear,
					grid: false,
					axis: {
						line: false,
						ticks: {
							size: 0,
							padding: 8,
							spacing: 56,
							format: (value: number) => formatBound(value, unit),
						},
					},
				},
				y,
			},
			focus: "group-x",
			maxFocusDistance: UNBOUNDED_FOCUS_DISTANCE,
			focusRing: false,
			tooltip: spec.showTooltip ? cursorTooltip("pointer") : false,
		}),
		focusKeyOf: (point) => `${point.datum.x1}`,
		tooltipOf: binTooltip,
	}
}

/** `CategoricalHistogram`'s `definition` memo. */
export const buildCategoricalHistogram = (
	spec: CategoricalSpec,
): BuiltChart<CategoricalBin, string, number> => {
	const { bins, color } = spec
	const maxCount = bins.reduce((max, bin) => Math.max(max, bin.value), 0)
	const { baseline, liftCount, y } = countAxis(maxCount, spec.useLogY)
	return {
		definition: defineChart({
			marks: [
				barY(bins, {
					x: (bin: CategoricalBin) => bin.name,
					y1: baseline,
					y2: (bin: CategoricalBin) => Math.max(liftCount(bin.value), baseline),
					fill: color,
					fillOpacity: 1,
					radius: 2,
					states: [{ when: { focus: "unmatched" }, style: { fillOpacity: DIMMED_BIN_OPACITY } }],
				}),
			],
			scales: {
				x: {
					scale: scaleBand<string>(
						bins.map((bin) => bin.name),
						[0, 1],
					).paddingInner(0.05),
					grid: false,
					axis: {
						line: false,
						ticks: { size: 0, padding: 8, format: binLowerBoundLabel },
						tickLabels: { thin: { minGap: 32, priority: "ends" } },
					},
				},
				y,
			},
			focus: "group-x",
			maxFocusDistance: UNBOUNDED_FOCUS_DISTANCE,
			focusRing: false,
			tooltip: spec.showTooltip ? cursorTooltip("pointer") : false,
		}),
		focusKeyOf: (point) => point.datum.name,
		tooltipOf: (points) =>
			Option.map(Option.fromNullishOr(points[0]?.datum), (bin) =>
				ChartTooltip.CategoricalBin({ name: bin.name, value: bin.value }),
			),
	}
}

/** `HistogramSpike`'s `bins` and `definition` memos: binX over raw observations. */
export const buildBinnedHistogram = (spec: BinnedSpec) => {
	const { logScaleY, color } = spec
	const bins = binX(
		spec.values.map((value) => ({ value })),
		{ value: (row: { value: number }) => row.value, thresholds: SPIKE_BIN_COUNT },
	)
	const baseline = logScaleY ? 1 : 0
	const maxCount = bins.reduce((max, bin) => Math.max(max, bin.value), 0)

	const definition = defineChart({
		marks: [
			rect(bins, {
				x1: (bin) => bin.x1,
				x2: (bin) => bin.x2,
				y1: () => baseline,
				y2: (bin) => Math.max(bin.value, baseline),
				fill: color,
				fillOpacity: 0.85,
				inset: 0.5,
				radius: 2,
				states: [{ when: { focus: "primary" }, style: { fillOpacity: 1 } }],
			}),
		],
		scales: {
			x: {
				scale: scaleLinear,
				grid: false,
				axis: { line: false, ticks: { size: 0, padding: 8, spacing: 56, format: formatNumber } },
			},
			y: logScaleY
				? {
						scale: scaleLog().domain([1, Math.max(maxCount, 10)]),
						grid: true,
						axis: { line: false, ticks: { size: 0, padding: 6, format: formatNumber } },
					}
				: {
						scale: scaleLinear().domain([0, Math.max(maxCount, 1)]),
						nice: true,
						grid: true,
						axis: { line: false, ticks: { size: 0, padding: 6, format: formatNumber } },
					},
		},
		focus: "nearest",
		focusRing: false,
		tooltip: cursorTooltip("pointer"),
	})

	const built: BuiltChart<(typeof bins)[number], number, number> = {
		definition,
		focusKeyOf: (point) => `${point.datum.x1}`,
		tooltipOf: binTooltip,
	}
	return built
}
