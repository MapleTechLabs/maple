import { areaY, d3Curve, defineChart, lineY, type ChartPoint, type ChartValue } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { makeBucketAxis, pinnedTimeXAxis } from "@maple/ui/components/plot/bucket-axis"
import { focusCrosshair } from "@maple/ui/components/plot/plot-focus"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import { linearYDomain, niceLinearDomain } from "@maple/ui/components/plot/plot-scales"
import { formatValueByUnit } from "@maple/ui/lib/format"
import { curveMonotoneX } from "d3-shape"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import { type InfraPoint, transformRows } from "../infra-metric-series"
import type { BuiltChart } from "./built-chart"
import { verticalGradient } from "./fixed-metric-axes"
import { cursorTooltip, tooltipFocusCapture } from "./plot-constants"

// The Cloudflare zone detail's stacked breakdown chart definition.

type StackedBreakdownSpec = Extract<ChartSpec, { readonly _tag: "StackedBreakdown" }>

/** One band segment: a bucket row, the series it belongs to, its value and where it sits in the stack. */
interface BreakdownCell {
	readonly row: InfraPoint
	readonly name: string
	readonly value: number
	readonly bottom: number
	readonly top: number
}

/** A key absent from a bucket row is a zero count: `stack()` would tear the band at a null. */
const cellValue = (value: unknown): number => (typeof value === "number" ? value : 0)

export const buildStackedBreakdown = (
	spec: StackedBreakdownSpec,
): BuiltChart<BreakdownCell, ChartValue, number> => {
	const { data } = transformRows(spec.rows)
	const series = spec.series
	const axis = makeBucketAxis(
		data.map((point) => point.bucket),
		spec.timeZone,
	)
	const yDomain = niceLinearDomain(linearYDomain({ rows: data, keys: series, stacked: true }))
	const chrome = { border: spec.colors.border ?? "", background: spec.colors.background ?? "" }
	const colorOf = (name: string) => spec.colors[name] ?? chrome.border
	const gradientFor = (name: string) => `${spec.gradientPrefix}-${name.replace(/\W+/g, "_")}`
	const cells: ReadonlyArray<BreakdownCell> = data.flatMap((row) =>
		series.reduce<ReadonlyArray<BreakdownCell>>((stacked, name) => {
			const bottom = stacked.at(-1)?.top ?? 0
			const value = cellValue(row[name])
			return [...stacked, { row, name, value, bottom, top: bottom + value }]
		}, []),
	)
	const curve = d3Curve(curveMonotoneX)
	const format = (value: number) => formatValueByUnit(value, spec.unit)
	const focus = tooltipFocusCapture()
	const definition = defineChart({
		gradients: series.map((name) => verticalGradient(gradientFor(name), colorOf(name), 0.4, 0.05)),
		marks: [
			// Fills without an outline: a stroked area also draws its sides and its floor.
			areaY(cells, {
				x: (cell: BreakdownCell) => cell.row.date,
				y: (cell: BreakdownCell) => cell.top,
				y1: (cell: BreakdownCell) => cell.bottom,
				z: (cell: BreakdownCell) => cell.name,
				fill: (cell: BreakdownCell) => `url(#${gradientFor(cell.name)})`,
				stroke: "none",
				curve,
			}),
			// Each band's top edge, the top band first: a band at 0 leaves the one under it visible.
			...series.toReversed().map((name) =>
				lineY(
					cells.filter((cell) => cell.name === name),
					{
						id: `edge-${name}`,
						x: (cell: BreakdownCell) => cell.row.date,
						y: (cell: BreakdownCell) => cell.top,
						stroke: colorOf(name),
						strokeWidth: 1.25,
						curve,
					},
				),
			),
			focusCrosshair(chrome),
		],
		scales: {
			x: spec.xDomainMs === undefined ? axis.x : pinnedTimeXAxis(axis.context, spec.xDomainMs),
			y: {
				grid: DASHED_Y_GRID,
				scale: scaleLinear().domain(yDomain),
				axis: {
					line: false,
					ticks: { size: 0, padding: 8, format: (v: number) => (v === 0 ? "0" : format(v)) },
				},
			},
		},
		margin: { top: 12, right: 12, left: spec.marginLeft ?? 60 },
		focus: "group-x",
		focusRing: false,
		tooltip: cursorTooltip<BreakdownCell>(focus.anchor),
	})
	const tooltipOf = (points: ReadonlyArray<ChartPoint<BreakdownCell, ChartValue, number>>) =>
		Option.map(Option.fromNullishOr(points[0]), ({ datum }) => {
			// The raw value: the cursor series carry no stacked position.
			const highlighted = focus.highlight(
				series.map((name): readonly [string, number | null] => {
					const value = datum.row[name]
					return [spec.labels[name] ?? name, typeof value === "number" ? value : null]
				}),
			)
			const base = {
				heading: axis.heading(datum.row.bucket),
				// Off the bucket ROW, so hovering one band still prints every series.
				rows: series.flatMap((name) => {
					const value = datum.row[name]
					return typeof value === "number"
						? [
								{
									label: spec.labels[name] ?? name,
									color: colorOf(name),
									dashed: false,
									value: format(value),
								},
							]
						: []
				}),
			}
			const total = series.reduce((sum, name) => sum + cellValue(datum.row[name]), 0)
			const withTotal = spec.showTotal === true ? { ...base, total: format(total) } : base
			return highlighted === undefined
				? ChartTooltip.Bucket(withTotal)
				: ChartTooltip.Bucket({ ...withTotal, highlighted })
		})
	return { definition, focusKeyOf: (point) => point.datum.row.bucket, tooltipOf }
}
