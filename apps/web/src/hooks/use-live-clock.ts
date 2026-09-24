import { useEffect, useState } from "react"

/** Coarse enough that a list of hundreds of rows re-renders rarely, fine enough
 *  that a pill is never more than this far past the live window it claims. */
export const LIVE_CLOCK_INTERVAL_MS = 30_000

/**
 * A "now" that advances, for UI whose truth expires on a timer.
 *
 * `Date.now()` read during render is a value, not a subscription: liveness
 * computed from it stays frozen at the moment of the last render, so a LIVE pill
 * outlives its window until some unrelated state change happens to repaint the
 * row. `/replays` mounts its refresh provider with auto-refresh off, so on a
 * list nobody is touching that repaint may never come.
 *
 * This is the same sanctioned exception to the no-useEffect rule as
 * {@link useIntervalRefresh} — React has no declarative way to say "re-render
 * when the wall clock passes a threshold". Unlike that hook a tick is local
 * state, not a refetch, so hidden tabs are not skipped: the browser already
 * throttles background timers, and skipping would leave a stale pill on screen
 * for the first interval after the tab comes back, which is the one moment
 * somebody is looking at it.
 *
 * Pass `enabled: false` when nothing on screen can expire — the clock then never
 * schedules a timer at all.
 */
export function useLiveClock({
	intervalMs = LIVE_CLOCK_INTERVAL_MS,
	enabled = true,
}: { intervalMs?: number; enabled?: boolean } = {}): number {
	const [nowMs, setNowMs] = useState(() => Date.now())

	useEffect(() => {
		if (!enabled) return
		// Re-sample on enable as well as on each tick: a clock that was disabled
		// while the tab sat idle would otherwise hand back the mount-time value.
		setNowMs(Date.now())
		const id = setInterval(() => setNowMs(Date.now()), intervalMs)
		return () => clearInterval(id)
	}, [intervalMs, enabled])

	return nowMs
}
