import type {
	ChartPoint,
	ChartTooltipAnchor,
	ChartTooltipAnchorContext,
	ChartTooltipPosition,
	ChartValue,
} from "@tanstack/charts"
import { findNearestSeriesKey } from "@maple/ui/components/charts/_shared/nearest-series"
import { tooltip } from "@tanstack/charts/tooltip"

// Copied from React modules of packages/ui/src/components/plot (plot-tooltip.tsx, plot-legend.tsx,
// plot-frame.tsx) so this file stays React-free. Phase 1 moves them to a shared module.

/** `cursorTooltip` (plot-tooltip.tsx): the shell themed by plot-tooltip.css, beside the cursor. */
export const cursorTooltip = <TDatum>(anchor: ChartTooltipAnchor<TDatum, ChartValue, number> | "pointer") =>
	({
		use: tooltip,
		className: "maple-plot-tooltip",
		anchor,
		placement: "right",
		offset: 12,
	}) as const

/** plot-legend.tsx: how far a non-highlighted series' colour is mixed into the background. */
export const MUTED_COLOR_AMOUNT = 0.78

/** plot-frame.tsx: `maxFocusDistance` for a chart that resolves focus anywhere in the plot. */
export const UNBOUNDED_FOCUS_DISTANCE = Number.MAX_SAFE_INTEGER

/** How far from a series' plotted point the cursor may sit and still emphasise it. */
const HIGHLIGHT_MAX_DISTANCE_PX = 24

interface TooltipFocus {
	readonly pointerY: number | null
	readonly mapY: ((value: number) => number) | null
}

interface FocusCell {
	current: TooltipFocus
}

/**
 * `createTooltipFocusStore`: the tooltip anchor records the pointer and the y scale on every
 * update, so the body can emphasise the series nearest the cursor. One per built definition.
 */
export const tooltipFocusCapture = () => {
	const cell: FocusCell = { current: { pointerY: null, mapY: null } }
	const anchor = <TDatum>(
		_points: ReadonlyArray<ChartPoint<TDatum, ChartValue, number>>,
		context: ChartTooltipAnchorContext<TDatum, ChartValue, number>,
	): ChartTooltipPosition | null => {
		const map = context.scales.y?.map
		cell.current = {
			pointerY: context.pointer?.y ?? null,
			mapY: map === undefined ? null : (value) => map(value),
		}
		return context.pointer
	}
	/**
	 * `resolveTooltipHighlight`: the label nearest the cursor among `plotted` (label to where its
	 * mark sits in y-data space); single-series charts emphasise nothing.
	 */
	const highlight = (
		plotted: ReadonlyArray<readonly [label: string, y: number | null]>,
	): string | undefined => {
		const { pointerY, mapY } = cell.current
		if (plotted.length <= 1 || mapY === null || pointerY === null) return undefined
		const yByLabel = Object.fromEntries(
			plotted.flatMap(([label, y]) => (y === null ? [] : [[label, mapY(y)] as const])),
		)
		return findNearestSeriesKey(
			yByLabel,
			plotted.map(([label]) => label),
			pointerY,
			HIGHLIGHT_MAX_DISTANCE_PX,
		)
	}
	return { anchor, highlight }
}
