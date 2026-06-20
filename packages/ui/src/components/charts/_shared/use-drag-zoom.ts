import * as React from "react"

import { cn } from "../../../lib/utils"

/** Minimal shape of the Recharts categorical-chart mouse-event state we read. */
interface RechartsMouseState {
	activeLabel?: string | number
}

/** Props for the selection `<ReferenceArea>`, spread by the caller when set. */
export interface DragZoomOverlayProps {
	x1: string
	x2: string
	strokeOpacity: number
	fill: string
	fillOpacity: number
	isAnimationActive: boolean
}

const OVERLAY_STYLE = {
	strokeOpacity: 0.3,
	fill: "var(--foreground)",
	fillOpacity: 0.08,
	isAnimationActive: false,
} as const

/** Recharts passes the native-ish mouse event as the second handler argument. */
interface MouseLikeEvent {
	clientX?: number
}

/**
 * Minimum horizontal travel (px) between mousedown and mouseup before a gesture
 * counts as a drag rather than a click. Below this, a plain click — or tiny
 * cursor jitter — must never trigger a zoom.
 */
const DRAG_THRESHOLD_PX = 6

const readClientX = (event: MouseLikeEvent | undefined): number | null =>
	typeof event?.clientX === "number" ? event.clientX : null

export interface ChartDragZoom {
	/** Whether drag-zoom is wired up (an `onZoomSelect` handler was provided). */
	enabled: boolean
	/** True while the user is actively dragging out a selection past the threshold. */
	isSelecting: boolean
	/**
	 * Classes for the chart container (an ancestor of `.recharts-surface`):
	 * crosshair cursor while enabled, and text-selection suppression mid-drag.
	 * Centralizes the magic class strings that were copy-pasted per chart.
	 */
	containerClassName: string
	/**
	 * Props for the selection `<ReferenceArea>`, or `null` when not dragging.
	 * Render as `{dragZoom.overlayProps && <ReferenceArea {...dragZoom.overlayProps} />}`.
	 * (Recharts must see `ReferenceArea` as a direct child, so the element itself
	 * can't be hidden behind a wrapper component — only its props are shared.)
	 */
	overlayProps: DragZoomOverlayProps | null
	/** Spread onto the Recharts chart element to capture the drag gesture. */
	chartHandlers: {
		onMouseDown?: (state: RechartsMouseState | undefined, event?: MouseLikeEvent) => void
		onMouseMove?: (state: RechartsMouseState | undefined, event?: MouseLikeEvent) => void
		onMouseUp?: (state: RechartsMouseState | undefined, event?: MouseLikeEvent) => void
		onMouseLeave?: (state: RechartsMouseState | undefined, event?: MouseLikeEvent) => void
	}
}

/**
 * Drag-to-zoom gesture for Recharts time-series charts.
 *
 * Tracks the bucket category under the cursor between mousedown and mouseup,
 * exposes the in-progress selection so the caller can render a `ReferenceArea`,
 * and on release invokes `onZoomSelect` with the two endpoints ordered
 * ascending. The click/drag decision is made purely from how far the pointer
 * travelled (`clientX` at mousedown vs mouseup), so a click never zooms —
 * regardless of where bucket boundaries fall.
 */
export function useChartDragZoom(
	onZoomSelect?: (range: { startBucket: string; endBucket: string }) => void,
): ChartDragZoom {
	const enabled = typeof onZoomSelect === "function"
	const [refAreaLeft, setRefAreaLeft] = React.useState<string | null>(null)
	const [refAreaRight, setRefAreaRight] = React.useState<string | null>(null)
	// True once the pointer has travelled past the click/drag threshold; drives
	// the selection overlay. Pixel origin is a ref so it never forces a re-render.
	const [isDragging, setIsDragging] = React.useState(false)
	const downXRef = React.useRef<number | null>(null)

	const reset = React.useCallback(() => {
		setRefAreaLeft(null)
		setRefAreaRight(null)
		setIsDragging(false)
		downXRef.current = null
	}, [])

	const onMouseDown = React.useCallback(
		(state: RechartsMouseState | undefined, event?: MouseLikeEvent) => {
			if (!enabled || state?.activeLabel == null) return
			const label = String(state.activeLabel)
			downXRef.current = readClientX(event)
			setIsDragging(false)
			setRefAreaLeft(label)
			setRefAreaRight(label)
		},
		[enabled],
	)

	const onMouseMove = React.useCallback(
		(state: RechartsMouseState | undefined, event?: MouseLikeEvent) => {
			if (!enabled || state?.activeLabel == null || downXRef.current == null) return
			setRefAreaRight((prev) => (prev === null ? prev : String(state.activeLabel)))
			const x = readClientX(event)
			if (x != null && Math.abs(x - downXRef.current) >= DRAG_THRESHOLD_PX) {
				setIsDragging(true)
			}
		},
		[enabled],
	)

	const commit = React.useCallback(
		(event?: MouseLikeEvent) => {
			if (!enabled) {
				reset()
				return
			}
			const upX = readClientX(event)
			const travelled =
				downXRef.current != null && upX != null
					? Math.abs(upX - downXRef.current) >= DRAG_THRESHOLD_PX
					: isDragging
			if (travelled && refAreaLeft !== null && refAreaRight !== null && refAreaLeft !== refAreaRight) {
				const leftMs = Date.parse(refAreaLeft)
				const rightMs = Date.parse(refAreaRight)
				const [startBucket, endBucket] =
					Number.isNaN(leftMs) || Number.isNaN(rightMs) || leftMs <= rightMs
						? [refAreaLeft, refAreaRight]
						: [refAreaRight, refAreaLeft]
				onZoomSelect?.({ startBucket, endBucket })
			}
			reset()
		},
		[enabled, isDragging, refAreaLeft, refAreaRight, onZoomSelect, reset],
	)

	const onMouseUp = React.useCallback(
		(_state: RechartsMouseState | undefined, event?: MouseLikeEvent) => commit(event),
		[commit],
	)
	const onMouseLeave = React.useCallback(
		(_state: RechartsMouseState | undefined, event?: MouseLikeEvent) => commit(event),
		[commit],
	)

	return {
		enabled,
		isSelecting: isDragging,
		containerClassName: cn(
			enabled && "[&_.recharts-surface]:cursor-crosshair",
			isDragging && "select-none",
		),
		// Only surface the selection overlay once it's a real drag, so a click
		// doesn't flash a zero-width marker.
		overlayProps:
			isDragging && refAreaLeft !== null && refAreaRight !== null
				? { x1: refAreaLeft, x2: refAreaRight, ...OVERLAY_STYLE }
				: null,
		chartHandlers: enabled ? { onMouseDown, onMouseMove, onMouseUp, onMouseLeave } : {},
	}
}
