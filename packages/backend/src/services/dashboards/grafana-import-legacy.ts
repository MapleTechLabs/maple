// Grafana's pre-5.0 `rows[].panels` schema (12-unit `span`, pixel row heights) as modern panels. Pure.
import { Array as Arr, String as Str } from "effect"
import { asArray, asFiniteNumber, asRecord, asString, type UnknownRecord } from "./dashboard-import-shared"

const DEFAULT_ROW_HEIGHT_PX = 250

/** A row height of `250px`, `"250"` or `250` in Grafana's 30px grid units. */
function rowUnits(height: unknown): number {
	const px = asFiniteNumber(height) ?? Number(Str.replace(/px$/u, "")(asString(height) ?? ""))
	return Math.max(2, Math.round((Number.isFinite(px) && px > 0 ? px : DEFAULT_ROW_HEIGHT_PX) / 30))
}

/**
 * Each old row becomes a modern row panel (when it shows a title) followed by its panels,
 * left to right by `span`, wrapping at 24 columns. A collapsed row keeps its panels nested.
 */
export function panelsFromLegacyRows(rows: unknown): ReadonlyArray<UnknownRecord> {
	const out: UnknownRecord[] = []
	let y = 0
	for (const item of asArray(rows)) {
		const row = asRecord(item)
		if (row === null) continue
		const title = asString(row.title)
		const titled = title !== undefined && row.showTitle !== false
		const collapsed = row.collapse === true
		const h = rowUnits(row.height)
		const rowPanel: UnknownRecord | undefined = titled
			? { type: "row", title, collapsed, gridPos: { x: 0, y, w: 24, h: 1 } }
			: undefined
		if (rowPanel !== undefined) y += 1
		const panels = Arr.flatMap(asArray(row.panels), (panel) => Arr.fromNullishOr(asRecord(panel)))
		let x = 0
		const placed = Arr.map(panels, (panel) => {
			const w = Math.min(
				24,
				Math.max(1, Math.round((asFiniteNumber(panel.span) ?? 12 / Math.max(1, panels.length)) * 2)),
			)
			if (x + w > 24) {
				x = 0
				y += h
			}
			const gridPos = { x, y, w, h }
			x += w
			return { ...panel, gridPos }
		})
		y += panels.length > 0 ? h : 0
		if (rowPanel !== undefined && collapsed) {
			out.push({ ...rowPanel, panels: placed })
		} else {
			if (rowPanel !== undefined) out.push(rowPanel)
			out.push(...placed)
		}
	}
	return out
}
