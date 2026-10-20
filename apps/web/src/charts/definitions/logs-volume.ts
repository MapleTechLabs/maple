import { bucketDate, makeBucketAxis } from "@maple/ui/components/plot/bucket-axis"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import { linearYDomain, niceLinearDomain } from "@maple/ui/components/plot/plot-scales"
import { formatNumber } from "@maple/ui/lib/format"
import { barY, defineChart, rect, stack } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { cursorTooltip } from "./plot-constants"

// The logs volume chart's definition.

type VolumeSpec = Extract<ChartSpec, { readonly _tag: "LogsVolume" }>
type Row = Readonly<Record<string, unknown>> & { readonly bucket: string }

/** One severity's slice of one bucket: `stack()` groups these on `z`. */
interface SeverityCell {
	readonly row: Row
	readonly bucket: string
	readonly date: Date
	readonly severity: string
	readonly value: number | null
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null)

export const buildLogsVolume = (spec: VolumeSpec): BuiltChart<SeverityCell, Date, number> => {
	const { seriesKeys, selection } = spec
	const chartData: ReadonlyArray<Row> = spec.buckets.map((bucket) => ({
		bucket: bucket.bucket,
		...bucket.counts,
	}))
	const color = (key: string) => spec.colors[key] ?? spec.border
	const axis = makeBucketAxis(
		chartData.map((row) => row.bucket),
		spec.timeZone,
	)
	const yDomain = niceLinearDomain(linearYDomain({ rows: chartData, keys: [...seriesKeys], stacked: true }))
	const cells: Array<SeverityCell> = chartData.flatMap((row) =>
		seriesKeys.map((severity) => ({
			row,
			bucket: row.bucket,
			date: bucketDate(row.bucket),
			severity,
			value: numberOrNull(row[severity]),
		})),
	)
	return {
		definition: defineChart({
			marks: [
				barY(cells, {
					x: (cell: SeverityCell) => cell.date,
					y: (cell: SeverityCell) => cell.value,
					z: (cell: SeverityCell) => cell.severity,
					fill: (cell: SeverityCell) => color(cell.severity),
					radius: 0,
					layout: stack({ order: [...seriesKeys] }),
				}),
				...(selection
					? [
							decorative(
								rect([selection], {
									x1: (s: { left: string; right: string }) => bucketDate(s.left),
									x2: (s: { left: string; right: string }) => bucketDate(s.right),
									y1: () => yDomain[0],
									y2: () => yDomain[1],
									fill: spec.border,
									fillOpacity: 0.25,
									stroke: "none",
								}),
							),
						]
					: []),
			],
			scales: {
				x: axis.xBand,
				y: {
					grid: DASHED_Y_GRID,
					scale: scaleLinear().domain(yDomain),
					axis: {
						line: false,
						ticks: { size: 0, padding: 4, format: (value: number) => formatNumber(value) },
					},
				},
			},
			margin: { top: 4, right: 0, left: 40 },
			focus: "group-x",
			focusRing: false,
			tooltip: spec.isSelecting ? false : cursorTooltip("pointer"),
		}),
		focusKeyOf: (point) => point.datum.bucket,
		tooltipOf: (points) =>
			Option.map(Option.fromNullishOr(points[0]?.datum), (cell) =>
				ChartTooltip.Bucket({
					heading: axis.heading(cell.bucket),
					rows: seriesKeys.flatMap((key) => {
						const value = numberOrNull(cell.row[key])
						return value === null
							? []
							: [
									{
										label: key.toUpperCase(),
										color: color(key),
										dashed: false,
										value: formatNumber(value),
									},
								]
					}),
				}),
			),
	}
}
