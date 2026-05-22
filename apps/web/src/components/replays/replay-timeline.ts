// ---------------------------------------------------------------------------
// Replay timeline mapping
//
// Session replays carry raw wall-clock time: rrweb's `totalTime` is just
// (last - first) event timestamp, so a 30s session left idle in a tab for 45
// minutes reports 45:00. The player already *skips* idle gaps during playback,
// but the scrubber/clock still showed the full wall-clock length.
//
// `buildTimeline` collapses each idle gap to a small constant so the displayed
// duration reflects active time, while still mapping back to rrweb's real clock
// for seeking/playback. Pass `[]` intervals for an identity mapping (used when
// "Skip idle" is toggled off — full wall-clock behaviour, unchanged).
// ---------------------------------------------------------------------------

/** An inactive stretch, in real ms from session start (start < end). */
export interface InactiveInterval {
	start: number
	end: number
}

/** Each idle gap shrinks to this length on the displayed (trimmed) timeline. */
export const COLLAPSED_GAP_MS = 1000

export interface Timeline {
	/** Displayed total = realTotal − Σ(gap − COLLAPSED_GAP_MS). */
	readonly activeTotalMs: number
	/** Real rrweb time → position on the trimmed timeline. */
	toDisplay(realMs: number): number
	/** Trimmed-timeline position → real rrweb time (for seeking). */
	toReal(displayMs: number): number
}

/**
 * Build a real⇄display time mapping that collapses each idle interval to
 * `COLLAPSED_GAP_MS`. Intervals are sorted and clamped to `[0, realTotalMs]`
 * defensively; overlapping/out-of-range intervals are tolerated.
 */
export function buildTimeline(
	intervals: ReadonlyArray<InactiveInterval>,
	realTotalMs: number,
): Timeline {
	const total = Math.max(0, realTotalMs)

	// Normalize: clamp to range, drop empty/degenerate gaps, sort, merge overlaps.
	const sorted = intervals
		.map((iv) => ({
			start: Math.max(0, Math.min(iv.start, total)),
			end: Math.max(0, Math.min(iv.end, total)),
		}))
		.filter((iv) => iv.end > iv.start)
		.sort((a, b) => a.start - b.start)

	const gaps: InactiveInterval[] = []
	for (const iv of sorted) {
		const last = gaps[gaps.length - 1]
		if (last && iv.start <= last.end) {
			last.end = Math.max(last.end, iv.end)
		} else {
			gaps.push({ ...iv })
		}
	}

	const savedBefore = (real: number): number => {
		let saved = 0
		for (const gap of gaps) {
			if (real >= gap.end) {
				saved += gap.end - gap.start - COLLAPSED_GAP_MS
			} else if (real > gap.start) {
				// Inside this gap: only the elapsed portion collapses, capped at COLLAPSED_GAP_MS.
				saved += real - gap.start - Math.min(real - gap.start, COLLAPSED_GAP_MS)
				break
			} else {
				break
			}
		}
		return saved
	}

	const activeTotalMs = total - savedBefore(total)

	const toDisplay = (realMs: number): number => {
		const real = Math.max(0, Math.min(realMs, total))
		return real - savedBefore(real)
	}

	const toReal = (displayMs: number): number => {
		const target = Math.max(0, Math.min(displayMs, activeTotalMs))
		// Walk active spans and collapsed gaps, accumulating display time until we
		// reach `target`. `realCursor` tracks the matching real position.
		let displayCursor = 0
		let realCursor = 0
		for (const gap of gaps) {
			const activeSpan = gap.start - realCursor
			if (target <= displayCursor + activeSpan) {
				return realCursor + (target - displayCursor)
			}
			displayCursor += activeSpan
			realCursor = gap.start
			// The collapsed gap: any target landing here resumes at the gap's end edge
			// (where content continues), matching the skip-idle playback jump.
			const collapsed = Math.min(COLLAPSED_GAP_MS, gap.end - gap.start)
			if (target < displayCursor + collapsed) {
				return gap.end
			}
			displayCursor += collapsed
			realCursor = gap.end
		}
		// Trailing active span after the last gap.
		return realCursor + (target - displayCursor)
	}

	return { activeTotalMs, toDisplay, toReal }
}
