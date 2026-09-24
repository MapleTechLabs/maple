// The lines both tool charts draw — the overview's scope chart and the detail
// page's grid — over a series `fillSeriesBuckets` has zero-filled, so a line
// drops to the baseline between bursts instead of bridging the silence.

import { d3Curve, lineY } from "@tanstack/charts"
import { curveMonotoneX } from "d3-shape"

import { focusDot, type PlotChromeColors } from "@maple/ui/components/plot"

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

/** A series at a bucket — one vertex of a line. `row` carries the whole bucket for the tooltip. */
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
