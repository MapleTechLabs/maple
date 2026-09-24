// The marks both tool charts draw — the overview's scope chart and the detail
// page's grid. Counts are grouped bars; readings (error rate, duration) are
// lines, drawn over a series `fillSeriesBuckets` has zero-filled so a line
// drops to the baseline between bursts instead of bridging the silence.

import { barY, d3Curve, group, lineY } from "@tanstack/charts"
import { curveMonotoneX } from "d3-shape"

import { focusDot, type PlotChromeColors } from "@maple/ui/components/plot"

const BAR_RADIUS = 2
const MAX_BAR_THICKNESS = 48
const DIMMED_FILL_OPACITY = 0.3
const LINE_WIDTH = 1.5

/** One series of a chart. `key` is the column it reads off the row. */
export interface ChartSeries {
	readonly key: string
	readonly label: string
	readonly color: string
}

export interface ChartRow extends Record<string, string | number | Date | null> {
	bucket: string
	date: Date
}

/** A series at a bucket — one bar, or one vertex of a line. `row` carries the whole bucket for the tooltip. */
export interface PlotCell {
	readonly row: ChartRow
	readonly key: string
	readonly color: string
}

export function valueAt(row: ChartRow, key: string): number | null {
	const value = row[key]
	return typeof value === "number" ? value : null
}

/** One line per series, each with its focus dot. */
export function seriesLines(
	rows: ReadonlyArray<ChartRow>,
	series: ReadonlyArray<ChartSeries>,
	colors: ReadonlyMap<string, string>,
	chromeColors: PlotChromeColors,
) {
	const at = (cell: PlotCell) => cell.row.date
	const valueOf = (cell: PlotCell) => valueAt(cell.row, cell.key)
	return series.flatMap((entry) => {
		const color = colors.get(entry.key) ?? chromeColors.border
		const cells = rows.map((row) => ({ row, key: entry.key, color }))
		return [
			lineY(cells, {
				id: entry.key,
				x: at,
				y: valueOf,
				stroke: color,
				strokeWidth: LINE_WIDTH,
				curve: d3Curve(curveMonotoneX),
			}),
			focusDot(cells, at, valueOf, color, chromeColors),
		]
	})
}

/**
 * Long-form bars: `barY` groups side by side off `z` within ONE mark. Grouped,
 * never stacked — the duration percentiles do not add. `lift` keeps one call
 * against a peak of hundreds from painting sub-pixel — see `minBarLength`.
 */
export function groupedBars(
	rows: ReadonlyArray<ChartRow>,
	series: ReadonlyArray<ChartSeries>,
	lift: (value: number | null) => number | null,
) {
	const cells = rows.flatMap((row) => series.map((entry) => ({ row, key: entry.key, color: entry.color })))
	return barY(cells, {
		x: (cell: PlotCell) => cell.row.date,
		y: (cell: PlotCell) => lift(valueAt(cell.row, cell.key)),
		z: (cell: PlotCell) => cell.key,
		fill: (cell: PlotCell) => cell.color,
		layout: group(),
		radius: BAR_RADIUS,
		maxThickness: MAX_BAR_THICKNESS,
		// The hovered bucket keeps its fill and every other one dims.
		states: [
			{
				when: (context: { matches: (match: "x") => boolean }) => !context.matches("x"),
				style: { fillOpacity: DIMMED_FILL_OPACITY },
			},
		],
	})
}
