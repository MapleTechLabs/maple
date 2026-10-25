import { heatmapSampleData } from "@maple/ui/components/charts/_shared/sample-data"

// `HeatmapSpike`'s model: empty rows and columns
// pruned, the holes listed, the colour domain and the cell geometry. Pure, so the lab page can
// render the "hidden" footer without loading the chart library.

export interface HeatmapSpikeRow {
	readonly x: string
	readonly y: string
	readonly value: number
}

export interface HeatmapHole {
	readonly x: string
	readonly y: string
}

export interface HeatmapSpikeModel {
	readonly xDomain: ReadonlyArray<string>
	readonly yDomain: ReadonlyArray<string>
	readonly domain: readonly [number, number]
	readonly visibleRows: ReadonlyArray<HeatmapSpikeRow>
	readonly holes: ReadonlyArray<HeatmapHole>
	readonly prunedColumns: number
	readonly prunedRows: number
	readonly geometry: Readonly<{ radius: number; inset: number; padding: number }>
}

export const HEATMAP_SPIKE_ROWS: ReadonlyArray<HeatmapSpikeRow> = heatmapSampleData

const cellKey = (x: string, y: string) => `${x}\u0000${y}`
const uniqueInOrder = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)]

const solveGeometry = (columns: number, rows: number): HeatmapSpikeModel["geometry"] => {
	if (columns > 40 || rows > 24) return { radius: 1, inset: 0.5, padding: 0.04 }
	if (columns > 18 || rows > 12) return { radius: 2, inset: 1, padding: 0.05 }
	return { radius: 3, inset: 1, padding: 0.06 }
}

const domainOf = (rows: ReadonlyArray<HeatmapSpikeRow>): readonly [number, number] => {
	const finite = rows.map((row) => row.value).filter((value) => Number.isFinite(value))
	if (finite.length === 0) return [0, 1]
	const min = Math.min(...finite)
	const max = Math.max(...finite)
	return min === max ? [min, min + 1] : [min, max]
}

/** `buildModel`. */
export const heatmapSpikeModel = (rows: ReadonlyArray<HeatmapSpikeRow>): HeatmapSpikeModel => {
	const present = new Set(rows.map((row) => cellKey(row.x, row.y)))
	const allX = uniqueInOrder(rows.map((row) => row.x))
	const allY = uniqueInOrder(rows.map((row) => row.y))
	const signal = new Set(
		rows
			.filter((row) => Number.isFinite(row.value) && row.value !== 0)
			.map((row) => cellKey(row.x, row.y)),
	)
	const nonEmptyX = allX.filter((x) => allY.some((y) => signal.has(cellKey(x, y))))
	const nonEmptyY = allY.filter((y) => allX.some((x) => signal.has(cellKey(x, y))))
	const xDomain = nonEmptyX.length > 0 ? nonEmptyX : allX
	const yDomain = [...(nonEmptyY.length > 0 ? nonEmptyY : allY)].reverse()
	const visibleX = new Set(xDomain)
	const visibleY = new Set(yDomain)
	const visibleRows = rows.filter((row) => visibleX.has(row.x) && visibleY.has(row.y))
	return {
		xDomain,
		yDomain,
		domain: domainOf(visibleRows),
		visibleRows,
		holes: xDomain.flatMap((x) => yDomain.flatMap((y) => (present.has(cellKey(x, y)) ? [] : [{ x, y }]))),
		prunedColumns: allX.length - nonEmptyX.length,
		prunedRows: allY.length - nonEmptyY.length,
		geometry: solveGeometry(xDomain.length, yDomain.length),
	}
}

const pluralize = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** The footer under the plot when anything was pruned, else `null`. */
export const heatmapPrunedNote = (model: HeatmapSpikeModel): string | null =>
	model.prunedColumns > 0 || model.prunedRows > 0
		? `${[
				model.prunedColumns > 0 ? pluralize(model.prunedColumns, "empty column") : null,
				model.prunedRows > 0 ? pluralize(model.prunedRows, "empty row") : null,
			]
				.filter((part) => part !== null)
				.join(" · ")} hidden`
		: null
