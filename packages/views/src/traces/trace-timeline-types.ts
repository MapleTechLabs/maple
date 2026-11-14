import type { SpanNode } from "@maple/ui/lib/types"

export interface TimelineBar {
	span: SpanNode
	row: number
	startMs: number
	endMs: number
	/** Start offset from the trace start (ms) — the `--b0` custom property on the bar. */
	offsetStartMs: number
	/** End offset from the trace start (ms) — the `--b1` custom property on the bar. */
	offsetEndMs: number
	depth: number
	parentSpanId: string
	isError: boolean
	isCollapsed: boolean
	childCount: number
	fill: string
	borderColor: string
	hasChildren: boolean
}

export interface ViewportState {
	startMs: number
	endMs: number
}

/**
 * The timeline's state: expanded parents, keyboard focus and search.
 */
export interface TimelineState {
	focusedIndex: number | null
	searchQuery: string
	expandedSpanIds: Set<string>
}

export const ROW_HEIGHT = 28
export const ROW_GAP = 1
export const MINIMAP_HEIGHT = 36
export const TIME_AXIS_HEIGHT = 28
export const DEPTH_INDENT = 16
export const OVERSCAN = 20
/** Absolute floor on the visible window so deep zoom can never collapse to zero width. */
export const MIN_VISIBLE_ABS_MS = 0.1
/** Default view shows at most this much time; longer traces open zoomed to the start. */
export const DEFAULT_MAX_WINDOW_MS = 10_000
export const SIDEBAR_WIDTH_DEFAULT = 320
export const SIDEBAR_WIDTH_MIN = 180
export const SIDEBAR_WIDTH_MAX = 640
export const SIDEBAR_WIDTH_STORAGE_KEY = "traceTimelineSidebarWidth"
/**
 * Floor for the auto-narrowed label column. Below `SIDEBAR_WIDTH_MIN` because this is not a width
 * anyone chose — it is what a phone-width pane can spare before the bars have nowhere to draw.
 */
export const SIDEBAR_WIDTH_NARROW_MIN = 140

/**
 * Narrowest label a tick can carry ("1.23 s" plus headroom). The ruler budgets ticks against
 * the measured column width rather than a fixed count, so labels never collide on a narrow
 * panel and never thin out to two on a wide one.
 */
export const MIN_TICK_PX = 56
