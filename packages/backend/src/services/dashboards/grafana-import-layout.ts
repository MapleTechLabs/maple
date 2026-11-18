// Grafana grid (24 columns, 30px rows) to Maple's (12 columns, 60px rows). Pure.
import { DASHBOARD_GRID_COLS } from "@maple/domain/http"
import { Array as Arr, Option, Order } from "effect"
import { asFiniteNumber, asRecord, type DashboardWidget } from "./dashboard-import-shared"

export interface GrafanaGridPos {
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
}

type Layout = DashboardWidget["layout"]

/** Grafana's own default for a panel saved without a `gridPos`. */
const DEFAULT_GRID_POS = { x: 0, w: 12, h: 8 } as const

/** A panel's `gridPos`, defaulted like Grafana does; `fallbackY` places a panel that has none. */
export function readGridPos(panel: unknown, fallbackY: number): GrafanaGridPos {
	const pos = asRecord(asRecord(panel)?.gridPos)
	return {
		x: Math.max(0, asFiniteNumber(pos?.x) ?? DEFAULT_GRID_POS.x),
		y: Math.max(0, asFiniteNumber(pos?.y) ?? fallbackY),
		w: Math.max(1, asFiniteNumber(pos?.w) ?? DEFAULT_GRID_POS.w),
		h: Math.max(1, asFiniteNumber(pos?.h) ?? DEFAULT_GRID_POS.h),
	}
}

const half = (edge: number) => Math.round(edge / 2)

/**
 * Converts by edges, so two Grafana panels that share an edge still share one:
 * neighbours never overlap. `originY` is the Grafana row the container starts at.
 */
export function convertGridPos(
	pos: GrafanaGridPos,
	originY: number,
	minimum: { readonly minW: number; readonly minH: number },
): { readonly layout: Layout; readonly grown: boolean } {
	const left = Math.min(DASHBOARD_GRID_COLS - 1, half(Math.min(pos.x, 24)))
	const right = Math.min(DASHBOARD_GRID_COLS, half(Math.min(pos.x + pos.w, 24)))
	const top = half(Math.max(0, pos.y - originY))
	const bottom = half(Math.max(0, pos.y + pos.h - originY))
	const w = Math.min(DASHBOARD_GRID_COLS, Math.max(minimum.minW, right - left, 1))
	const h = Math.max(minimum.minH, bottom - top, 1)
	return {
		layout: { x: Math.min(left, DASHBOARD_GRID_COLS - w), y: top, w, h, ...minimum },
		grown: w !== right - left || h !== bottom - top,
	}
}

const overlaps = (a: Layout, b: Layout) =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

interface Tile {
	readonly layout: Layout
	readonly grown: boolean
	readonly index: number
}

// Tiles kept at their converted size claim their place first, top to bottom.
const placementOrder = Order.combine(
	Order.mapInput(Order.Boolean, (tile: Tile) => tile.grown),
	Order.combine(
		Order.mapInput(Order.Number, (tile: Tile) => tile.layout.y),
		Order.mapInput(Order.Number, (tile: Tile) => tile.layout.x),
	),
)

/**
 * Pushes a tile down below anything it overlaps. Only a tile grown to its panel type's
 * minimum can overlap after `convertGridPos`, so those move and their neighbours stay put.
 */
export function resolveOverlaps(
	tiles: ReadonlyArray<{ readonly layout: Layout; readonly grown: boolean }>,
): ReadonlyArray<Layout> {
	const order = Arr.sort(
		Arr.map(tiles, (tile, index) => ({ ...tile, index })),
		placementOrder,
	)
	const placed: Layout[] = []
	const out: Layout[] = Arr.map(tiles, (tile) => tile.layout)
	for (const { layout, index } of order) {
		let current = layout
		let blocker = Arr.findFirst(placed, (other) => overlaps(current, other))
		while (Option.isSome(blocker)) {
			current = { ...current, y: blocker.value.y + blocker.value.h }
			blocker = Arr.findFirst(placed, (other) => overlaps(current, other))
		}
		placed.push(current)
		out[index] = current
	}
	return out
}
