import { useEffect, useState } from "react"

/**
 * Whole seconds since this component started waiting.
 *
 * The transcript's live line is the only thing on screen while a tool call runs, and a
 * spinner with no number cannot distinguish "warehouse query, four seconds" from "wedged".
 * Counting from mount is deliberate: the component that shows a duration is mounted exactly
 * when the wait starts, so there is no start timestamp to thread through the memo barriers
 * between the transcript and a row.
 *
 * The same sanctioned exception to the no-useEffect rule as {@link useLiveClock} — a wall
 * clock crossing a threshold has no declarative form. Rendering starts at 0 and the caller
 * decides when a number is worth showing.
 */
export function useElapsedSeconds(): number {
	const [seconds, setSeconds] = useState(0)

	useEffect(() => {
		const startedAt = Date.now()
		const id = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)
		return () => clearInterval(id)
	}, [])

	return seconds
}

/** `4s`, `1m 12s` — a duration a reader parses without counting digits. Empty below the floor. */
export function formatElapsed(seconds: number, floorSeconds = 2): string {
	if (seconds < floorSeconds) return ""
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	return `${minutes}m ${seconds % 60}s`
}
