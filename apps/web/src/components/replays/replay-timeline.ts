// Span ⇄ recording alignment
//
// Backend spans carry an absolute start timestamp; the recording's playhead is
// measured from the *first rrweb event* (ms-epoch), not the session metadata's
// start time. Aligning a span therefore means: parse its absolute start and take
// the offset from the rrweb epoch.

/**
 * Parse a ClickHouse DateTime64 string (`"YYYY-MM-DD HH:mm:ss[.fff]"`, UTC, no
 * zone) to ms-since-epoch. Normalizes to ISO 8601 UTC first so the result is
 * deterministic across JS engines (a bare space-separated string is
 * implementation-defined for `Date.parse`). Returns `NaN` for unparseable input.
 */
export function parseChTimestampMs(ts: string): number {
	if (!ts) return Number.NaN
	const normalized = ts.includes("T") ? ts : ts.replace(" ", "T")
	const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized)
	return Date.parse(hasZone ? normalized : `${normalized}Z`)
}

interface SpanRange {
	/** Span start as an offset (ms) from the recording's first event. */
	readonly realOffsetMs: number
	/** Span start, clamped to `[0, realTotalMs]`. */
	readonly startMs: number
	/** Span end, clamped to `[0, realTotalMs]` (≥ startMs). */
	readonly endMs: number
	/**
	 * True when the span falls outside `[0, realTotalMs]` — clock skew between the
	 * browser recording and backend spans is normal. Callers pin these to the
	 * nearest edge with a subtle affordance rather than dropping them.
	 */
	readonly outOfRange: boolean
}

/**
 * Place a backend span on the recording timeline. `recordingStartEpochMs` is the
 * first rrweb event timestamp (`deriveMeta.startTime`), the playhead's time-zero.
 */
export function spanRange(args: {
	spanStartIso: string
	durationMs: number
	recordingStartEpochMs: number
	realTotalMs: number
}): SpanRange {
	const spanStartEpochMs = parseChTimestampMs(args.spanStartIso)
	if (Number.isNaN(spanStartEpochMs)) {
		return { realOffsetMs: 0, startMs: 0, endMs: 0, outOfRange: true }
	}
	const realOffsetMs = spanStartEpochMs - args.recordingStartEpochMs
	const realEndMs = realOffsetMs + Math.max(0, args.durationMs)
	const outOfRange = realOffsetMs < 0 || realOffsetMs > args.realTotalMs
	// Skewed spans pin to the nearest edge.
	const clamp = (ms: number) => Math.max(0, Math.min(ms, args.realTotalMs))
	return { realOffsetMs, startMs: clamp(realOffsetMs), endMs: clamp(realEndMs), outOfRange }
}
