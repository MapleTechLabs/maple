import { clampPosition, clampSize } from "./layout.ts"
import type { GridGeometry, GridItem, PixelRect } from "./types.ts"

// Grid units <-> pixels. The rendered grid is native CSS Grid, so the browser
// does the placement; these are for the moments the code needs the numbers
// itself: turning a pointer position into a cell, and drawing the lifted tile
// where its cell is.

export function columnWidth(geometry: GridGeometry): number {
	const { width, cols, gap, padding } = geometry
	return (width - gap[0] * (cols - 1) - padding[0] * 2) / cols
}

/** Span in px of `units` tracks of `size` with `gap` between them. */
function span(units: number, size: number, gap: number): number {
	return units * size + Math.max(0, units - 1) * gap
}

/** Where an item's box sits inside the container's padding box. */
export function itemRect(geometry: GridGeometry, item: Pick<GridItem, "x" | "y" | "w" | "h">): PixelRect {
	const colWidth = columnWidth(geometry)
	const { rowHeight, gap, padding } = geometry
	return {
		left: (colWidth + gap[0]) * item.x + padding[0],
		top: (rowHeight + gap[1]) * item.y + padding[1],
		width: span(item.w, colWidth, gap[0]),
		height: span(item.h, rowHeight, gap[1]),
	}
}

/**
 * The cell a tile of this item's width lands in when its top-left corner is at
 * (`left`, `top`) px. Nearest cell, clamped into the grid.
 */
export function cellAt(
	geometry: GridGeometry,
	item: GridItem,
	left: number,
	top: number,
): { x: number; y: number } {
	const colWidth = columnWidth(geometry)
	const { rowHeight, gap, padding, cols } = geometry
	const x = Math.round((left - padding[0]) / (colWidth + gap[0]))
	const y = Math.round((top - padding[1]) / (rowHeight + gap[1]))
	return clampPosition(item, x, y, cols)
}

/** The size in cells nearest to a box of `width` x `height` px, clamped. */
export function sizeAt(
	geometry: GridGeometry,
	item: GridItem,
	width: number,
	height: number,
): { w: number; h: number } {
	const colWidth = columnWidth(geometry)
	const { rowHeight, gap, cols } = geometry
	const w = Math.max(1, Math.round((width + gap[0]) / (colWidth + gap[0])))
	const h = Math.max(1, Math.round((height + gap[1]) / (rowHeight + gap[1])))
	return clampSize(item, w, h, cols)
}
