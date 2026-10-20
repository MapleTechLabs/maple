import { muteColor } from "@maple/ui/components/plot/color-scale"
import { formatBucketLabel, formatNumber } from "@maple/ui/lib/format"
import {
	STACKED_BAR_PARTIAL_ROWS,
	STACKED_BAR_SERVICES,
	STACKED_BAR_SPIKE_ROWS,
	stackedBarAxisContext,
	type StackedBarSpikeRow,
} from "./timeseries-data"
import { barY, type ChartPoint, type ChartValue, defineChart, stack } from "@tanstack/charts"
import { scaleBand } from "@tanstack/charts-scales/band"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { controlledSignal } from "@tanstack/charts/interaction/signal"
import { type InteractiveColorLegendChange, interactiveColorLegend } from "@tanstack/charts/legend"
import { Option } from "effect"
import { ChartTooltip } from "../../charts/chart-spec"
import type { BuiltChart } from "../../charts/definitions/built-chart"
import { cursorTooltip, MUTED_COLOR_AMOUNT } from "../../charts/definitions/plot-constants"
import type { SpikeSpec } from "./spike-spec"
import { STACK_TOKEN_BY_SERVICE } from "./spike-timeseries-tokens"

// `StackedBarSpike`, `StackedBarLegendSpike` and `StackedBarSceneLegendSpike`, definition half.

type Point = ChartPoint<StackedBarSpikeRow, ChartValue, number>

const PARTIAL_DASHARRAY = "4 4"
const SOLID_DASHARRAY = "0"

const isIncomplete = (spec: SpikeSpec): boolean => spec.arm === "stacked-bar-incomplete-tanstack"
const rowsOf = (spec: SpikeSpec) => (isIncomplete(spec) ? STACKED_BAR_PARTIAL_ROWS : STACKED_BAR_SPIKE_ROWS)

/** `useServiceColor`, with the legend arm's emphasis applied (`emphasisedColorFor`). */
const colorForOf = (spec: SpikeSpec) => {
	const base = (service: string): string =>
		spec.colors[STACK_TOKEN_BY_SERVICE.get(service) ?? "--chart-1"] ?? ""
	const highlighted = spec.highlighted
	if (highlighted === null) return base
	const background = spec.colors["--background"] ?? ""
	return (service: string) =>
		service === highlighted ? base(service) : muteColor(base(service), background, MUTED_COLOR_AMOUNT)
}

const byBucketOf = (
	rows: ReadonlyArray<StackedBarSpikeRow>,
): ReadonlyMap<string, ReadonlyArray<StackedBarSpikeRow>> =>
	rows.reduce(
		(map, row) => map.set(row.bucket, [...(map.get(row.bucket) ?? []), row]),
		new Map<string, ReadonlyArray<StackedBarSpikeRow>>(),
	)

const stackMaxOf = (byBucket: ReadonlyMap<string, ReadonlyArray<StackedBarSpikeRow>>): number =>
	[...byBucket.values()].reduce(
		(max, rows) =>
			Math.max(
				max,
				rows.reduce((sum, row) => sum + row.spans, 0),
			),
		0,
	)

const scalesOf = (
	buckets: ReadonlyArray<string>,
	stackMax: number,
	axisContext: ReturnType<typeof stackedBarAxisContext>,
) => ({
	x: {
		scale: scaleBand<string>([...buckets], [0, 1]).paddingInner(0.2),
		axis: {
			line: false,
			ticks: {
				size: 0,
				padding: 8,
				spacing: 72,
				format: (value: string) => formatBucketLabel(value, axisContext, "tick"),
			},
		},
	},
	y: {
		scale: scaleLinear().domain([0, stackMax]),
		nice: true,
		grid: true,
		axis: { line: false, ticks: { size: 0, padding: 6, format: formatNumber } },
	},
})

/** The bucket's rows, the hovered service emphasised, and their total. */
const bucketTooltip =
	(
		byBucket: ReadonlyMap<string, ReadonlyArray<StackedBarSpikeRow>>,
		axisContext: ReturnType<typeof stackedBarAxisContext>,
		colorFor: (service: string) => string,
	) =>
	(points: ReadonlyArray<Point>): Option.Option<ChartTooltip> =>
		Option.map(Option.fromNullishOr(points[0]?.datum), (datum) => {
			const rows = byBucket.get(datum.bucket) ?? []
			return ChartTooltip.Bucket({
				heading: `${formatBucketLabel(datum.bucket, axisContext, "tooltip")}${datum.partial ? " · partial" : ""}`,
				highlighted: datum.service,
				rows: rows.map((row) => ({
					label: row.service,
					color: colorFor(row.service),
					dashed: row.partial,
					value: formatNumber(row.spans),
				})),
				total: formatNumber(rows.reduce((sum, row) => sum + row.spans, 0)),
			})
		})

/** `StackedBarFigure`. */
export const buildStackedBarSpike = (spec: SpikeSpec): BuiltChart<StackedBarSpikeRow, ChartValue, number> => {
	const rows = rowsOf(spec)
	const incomplete = isIncomplete(spec)
	const colorFor = colorForOf(spec)
	const foreground = spec.colors["--foreground"] ?? ""
	const axisContext = stackedBarAxisContext(rows)
	const byBucket = byBucketOf(rows)
	const definition = defineChart({
		marks: [
			barY(rows, {
				x: (d: StackedBarSpikeRow) => d.bucket,
				y: (d: StackedBarSpikeRow) => d.spans,
				z: (d: StackedBarSpikeRow) => d.service,
				fill: (d: StackedBarSpikeRow) => colorFor(d.service),
				layout: stack({ order: STACKED_BAR_SERVICES }),
				inset: 0.5,
				radius: 0,
				stroke: (d: StackedBarSpikeRow) => (incomplete && d.partial ? foreground : "transparent"),
				strokeDasharray: (d: StackedBarSpikeRow) =>
					incomplete && d.partial ? PARTIAL_DASHARRAY : SOLID_DASHARRAY,
				strokeWidth: 1.5,
				fillOpacity: 1,
				states: [{ when: { focus: "primary" }, style: { fillOpacity: 1 } }],
			}),
		],
		scales: scalesOf([...byBucket.keys()], stackMaxOf(byBucket), axisContext),
		focus: "nearest",
		focusRing: false,
		tooltip: cursorTooltip("pointer"),
	})
	return {
		definition,
		focusKeyOf: (point) => `${point.datum.bucket}:${point.datum.service}`,
		tooltipOf: bucketTooltip(byBucket, axisContext, colorFor),
	}
}

/** `StackedBarSceneLegendSpike`: the library's own legend, which can only hide a band. */
export const buildStackedBarSceneSpike =
	(onToggle: (key: string, keys: ReadonlyArray<string>) => void) =>
	(spec: SpikeSpec): BuiltChart<StackedBarSpikeRow, ChartValue, number> => {
		const rows = STACKED_BAR_SPIKE_ROWS
		const colorFor = colorForOf({ ...spec, highlighted: null })
		const axisContext = stackedBarAxisContext(rows)
		const byBucket = byBucketOf(rows)
		const visible = STACKED_BAR_SERVICES.filter((service) => !spec.hidden.includes(service))
		const definition = defineChart({
			marks: [
				barY(rows, {
					x: (d: StackedBarSpikeRow) => d.bucket,
					y: (d: StackedBarSpikeRow) => d.spans,
					color: (d: StackedBarSpikeRow) => d.service,
					layout: stack({ order: STACKED_BAR_SERVICES }),
					inset: 0.5,
					radius: 0,
					states: [{ when: { focus: "primary" }, style: { fillOpacity: 1 } }],
				}),
			],
			color: {
				domain: STACKED_BAR_SERVICES,
				range: STACKED_BAR_SERVICES.map(colorFor),
				legend: interactiveColorLegend({
					visible: controlledSignal<ReadonlyArray<string>, InteractiveColorLegendChange<string>>(
						visible,
						(_next, { reason }) => onToggle(reason.value, STACKED_BAR_SERVICES),
					),
					placement: "bottom",
					ariaLabel: "Spans by service",
				}),
			},
			scales: scalesOf([...byBucket.keys()], stackMaxOf(byBucket) || 1, axisContext),
			focus: "nearest",
			focusRing: false,
			tooltip: cursorTooltip("pointer"),
		})
		return {
			definition,
			focusKeyOf: (point) => `${point.datum.bucket}:${point.datum.service}`,
			// One row, no heading: the hovered band alone.
			tooltipOf: (points) =>
				Option.map(Option.fromNullishOr(points[0]?.datum), (datum) =>
					ChartTooltip.Bucket({
						heading: "",
						rows: [
							{
								label: datum.service,
								color: colorFor(datum.service),
								dashed: false,
								value: formatNumber(datum.spans),
							},
						],
					}),
				),
		}
	}
