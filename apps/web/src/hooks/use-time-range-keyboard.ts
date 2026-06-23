import { useHotkeys, type UseHotkeyDefinition } from "@tanstack/react-hotkeys"
import { useRef } from "react"
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
type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"

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
function applyKey(key: ArrowKey, mod: Modifier, { startMs, endMs }: ResolvedRange): ResolvedRange | null {
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
	/** When false, the hotkeys stay registered but don't fire. */
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
 * Registered through TanStack Hotkeys. Because the matcher requires exact
 * modifier state, each arrow key is registered three times — plain, `Shift+`,
 * and `Ctrl+`/`Meta+` — mapping to the base / strong / fine step. The handler
 * bails while an editable element is focused or any overlay (dialog, menu,
 * listbox) owns the keyboard, so it never hijacks menu/select navigation.
 */
export function useTimeRangeKeyboardControls({
	start,
	end,
	enabled = true,
	onChange,
}: UseTimeRangeKeyboardControls): void {
	// Read the latest range/handler from a ref so the callbacks stay stable
	// across range changes (TanStack Hotkeys syncs callbacks each render anyway,
	// but this keeps the closure reading current values).
	const stateRef = useRef({ start, end, onChange })
	stateRef.current = { start, end, onChange }

	const run = (key: ArrowKey, mod: Modifier, event: KeyboardEvent) => {
		// Defer to editable fields and keyboard-owning overlays (menu / listbox /
		// dialog) so their own arrow navigation keeps working.
		if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return
		if (isOverlayOpen()) return

		const { start: s, end: en, onChange: emit } = stateRef.current
		const startMs = parseMs(s)
		const endMs = parseMs(en)
		if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return

		const next = applyKey(key, mod, { startMs, endMs })
		if (!next) return
		emit({
			startTime: formatForTinybird(new Date(next.startMs)),
			endTime: formatForTinybird(new Date(next.endMs)),
		})
	}

	const arrows: ArrowKey[] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]
	const definitions: UseHotkeyDefinition[] = arrows.flatMap((key) => [
		{ hotkey: { key }, callback: (e) => run(key, "base", e) },
		{ hotkey: { key, shift: true }, callback: (e) => run(key, "shift", e) },
		// Ctrl and Meta both map to the fine step; register both since the
		// matcher requires exact modifier state.
		{ hotkey: { key, ctrl: true }, callback: (e) => run(key, "fine", e) },
		{ hotkey: { key, meta: true }, callback: (e) => run(key, "fine", e) },
	])

	useHotkeys(definitions, { enabled, ignoreInputs: true, stopPropagation: false })
}
