import { useEffect, useRef } from "react"
import { isEditableTarget, isOverlayOpen } from "@/lib/keyboard"
import { formatForTinybird } from "@/lib/time-utils"
import { normalizeTimestampInput } from "@/lib/timezone-format"

/** Minimum window width zoom-in can shrink to (1 minute). */
const MIN_WINDOW_MS = 60 * 1000
/** Earliest start zoom-out / left-pan may reach (~2 years before now). */
const MAX_LOOKBACK_MS = 2 * 365 * 24 * 60 * 60 * 1000

/**
 * Step multipliers. The base fraction is the slice of the current window
 * width applied per keypress; Shift makes the action "significantly stronger",
 * Control/Meta "significantly smaller". Pan and zoom each have their own base.
 */
const PAN_FRACTION = { base: 0.2, shift: 1.0, fine: 0.04 } as const
const ZOOM_FRACTION = { base: 0.2, shift: 0.5, fine: 0.04 } as const

type Modifier = "base" | "shift" | "fine"

function modifierOf(e: KeyboardEvent): Modifier {
	// Control or Meta → fine. Shift → strong. (Shift loses to Ctrl/Meta if both
	// are somehow held, which keeps fine-control predictable.)
	if (e.ctrlKey || e.metaKey) return "fine"
	if (e.shiftKey) return "shift"
	return "base"
}

function parseMs(warehouse: string): number {
	return new Date(normalizeTimestampInput(warehouse)).getTime()
}

interface ResolvedRange {
	startMs: number
	endMs: number
}

/**
 * Clamp a window into the allowed band `[now − MAX_LOOKBACK_MS, now]`,
 * preserving its width when it fits. If the window is wider than the whole band
 * (reachable when a custom range spans more than the lookback), it collapses to
 * exactly the full band rather than letting one edge escape past `now` or before
 * the floor. Done as a single pass so the two bounds can't leak past each other
 * the way two independent `if` clamps could.
 */
function clampToBand(startMs: number, endMs: number): ResolvedRange {
	const now = Date.now()
	const earliest = now - MAX_LOOKBACK_MS
	const width = endMs - startMs
	if (width >= MAX_LOOKBACK_MS) return { startMs: earliest, endMs: now }
	if (endMs > now) return { startMs: now - width, endMs: now }
	if (startMs < earliest) return { startMs: earliest, endMs: earliest + width }
	return { startMs, endMs }
}

/**
 * Pan/zoom the [start, end] window for one keypress, clamping so:
 * - `end` never exceeds now,
 * - `start` never precedes now − MAX_LOOKBACK_MS,
 * - the width never falls below MIN_WINDOW_MS.
 * Returns `null` when the action is a no-op (already clamped).
 */
function applyKey(
	key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
	mod: Modifier,
	{ startMs, endMs }: ResolvedRange,
): ResolvedRange | null {
	const width = Math.max(MIN_WINDOW_MS, endMs - startMs)

	let nextStart: number
	let nextEnd: number

	if (key === "ArrowLeft" || key === "ArrowRight") {
		const delta = width * PAN_FRACTION[mod] * (key === "ArrowLeft" ? -1 : 1)
		nextStart = startMs + delta
		nextEnd = endMs + delta
	} else {
		const center = (startMs + endMs) / 2
		const fraction = ZOOM_FRACTION[mod]
		// Up = zoom in (shrink), Down = zoom out (grow).
		const nextWidth =
			key === "ArrowUp" ? Math.max(MIN_WINDOW_MS, width * (1 - fraction)) : width * (1 + fraction)
		const half = nextWidth / 2
		nextStart = center - half
		nextEnd = center + half
	}

	const clamped = clampToBand(nextStart, nextEnd)
	nextStart = Math.round(clamped.startMs)
	nextEnd = Math.round(clamped.endMs)
	if (nextEnd - nextStart < MIN_WINDOW_MS) return null
	if (nextStart === startMs && nextEnd === endMs) return null
	return { startMs: nextStart, endMs: nextEnd }
}

export interface UseTimeRangeKeyboardControls {
	/** Resolved absolute start, warehouse format "YYYY-MM-DD HH:mm:ss" (UTC). */
	start: string
	/** Resolved absolute end, warehouse format "YYYY-MM-DD HH:mm:ss" (UTC). */
	end: string
	/** When false, the listener stays detached. */
	enabled?: boolean
	/** Receives the new absolute window in warehouse format. */
	onChange: (range: { startTime: string; endTime: string }) => void
}

/**
 * Arrow-key pan/zoom for a page's selected time window. Operates on the
 * resolved absolute range and always writes an absolute range back via
 * `onChange`:
 * - Left / Right → pan into the past / future (Right clamps at now).
 * - Up / Down → zoom in / out around the window center (clamped).
 * - Shift → much larger step; Ctrl/Meta → much finer step.
 *
 * The listener runs on `window` in the capture phase so arrow keys reach the
 * page even when the browser/OS would otherwise act on them, and it
 * `preventDefault()`/`stopPropagation()`s only the keys it handles. It bails
 * out while an editable element is focused or a modal dialog owns the keyboard.
 */
export function useTimeRangeKeyboardControls({
	start,
	end,
	enabled = true,
	onChange,
}: UseTimeRangeKeyboardControls): void {
	// Read the latest range/handler from a ref so the capture listener stays
	// attached across range changes instead of re-binding on every keypress.
	const stateRef = useRef({ start, end, onChange })
	stateRef.current = { start, end, onChange }

	useEffect(() => {
		if (!enabled) return

		const handler = (e: KeyboardEvent) => {
			if (e.altKey) return
			if (
				e.key !== "ArrowLeft" &&
				e.key !== "ArrowRight" &&
				e.key !== "ArrowUp" &&
				e.key !== "ArrowDown"
			) {
				return
			}
			if (isEditableTarget(e.target)) return
			if (isEditableTarget(document.activeElement)) return
			if (isOverlayOpen()) return

			const { start: s, end: en, onChange: emit } = stateRef.current
			const startMs = parseMs(s)
			const endMs = parseMs(en)
			if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return

			// We own this key: stop the browser/OS (and capture-phase siblings)
			// from acting on it before we apply the pan/zoom.
			e.preventDefault()
			e.stopPropagation()

			const next = applyKey(e.key, modifierOf(e), { startMs, endMs })
			if (!next) return
			emit({
				startTime: formatForTinybird(new Date(next.startMs)),
				endTime: formatForTinybird(new Date(next.endMs)),
			})
		}

		window.addEventListener("keydown", handler, { capture: true })
		return () => window.removeEventListener("keydown", handler, { capture: true })
	}, [enabled])
}
