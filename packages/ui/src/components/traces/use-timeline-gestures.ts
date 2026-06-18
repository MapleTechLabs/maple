import * as React from "react"

interface Viewport {
	startMs: number
	endMs: number
}

type TimelineAction = {
	type: "ZOOM"
	centerMs: number
	factor: number
	traceStartMs: number
	traceEndMs: number
}

interface UseTimelineGesturesOptions {
	/** The canvas host element — wheel events are bound here and the cursor x is measured against it. */
	scrollRef: React.RefObject<HTMLElement | null>
	viewport: Viewport
	traceStartMs: number
	traceEndMs: number
	dispatch: (action: TimelineAction) => void
}

/**
 * Ctrl/⌘ + wheel zooms the timeline's time-scale around the cursor. Plain wheel/trackpad
 * gestures are left untouched so they drive the native horizontal scroller (left/right) and
 * the row scroller (up/down) — the timeline is scrolled, not panned.
 */
export function useTimelineGestures({
	scrollRef,
	viewport,
	traceStartMs,
	traceEndMs,
	dispatch,
}: UseTimelineGesturesOptions) {
	// Native listener (passive: false) so we can preventDefault the browser's pinch-zoom.
	const wheelHandlerRef = React.useRef<(e: WheelEvent) => void>(undefined)
	wheelHandlerRef.current = (e: WheelEvent) => {
		if (e.deltaY === 0 || !(e.ctrlKey || e.metaKey)) return
		e.preventDefault()
		const el = scrollRef.current
		if (!el) return
		const rect = el.getBoundingClientRect()
		const mousePercent = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5
		const visibleDuration = viewport.endMs - viewport.startMs
		const centerMs = viewport.startMs + mousePercent * visibleDuration
		const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
		dispatch({ type: "ZOOM", centerMs, factor, traceStartMs, traceEndMs })
	}

	React.useEffect(() => {
		const el = scrollRef.current
		if (!el) return
		const handler = (e: WheelEvent) => wheelHandlerRef.current?.(e)
		el.addEventListener("wheel", handler, { passive: false })
		return () => el.removeEventListener("wheel", handler)
	}, [scrollRef])
}
