// ---------------------------------------------------------------------------
// Replay event-stream normalization
//
// The player concatenates a session's rrweb chunk blobs into one event array.
// Sessions recorded before chunk sequences became monotonic-per-session can
// carry duplicate/overwritten chunk-index rows whose blobs decode out of order,
// so the concatenated stream may be scrambled or contain duplicates. rrweb's
// `getMetaData().totalTime` (last − first timestamp) and the player's
// idle-collapse both assume a clean, chronologically-ordered stream — feed them
// a corrupted one and the reported length balloons to the whole tab lifetime.
//
// `normalizeEvents` repairs the stream so those legacy sessions stay playable.
// ---------------------------------------------------------------------------

function timestampOf(event: unknown): number {
	return typeof event === "object" &&
		event !== null &&
		typeof (event as { timestamp?: unknown }).timestamp === "number"
		? (event as { timestamp: number }).timestamp
		: 0
}

/**
 * Stable-sort the concatenated event stream by timestamp and drop exact adjacent
 * duplicates. Equal timestamps keep their original (chunk-seq) order, matching
 * how rrweb recorded them; distinct events that merely share a timestamp survive.
 */
export function normalizeEvents(events: ReadonlyArray<unknown>): unknown[] {
	const sorted = events
		.map((event, index) => ({ event, index, ts: timestampOf(event) }))
		.sort((a, b) => a.ts - b.ts || a.index - b.index)
	const out: unknown[] = []
	let prev: string | undefined
	for (const { event } of sorted) {
		const key = JSON.stringify(event)
		if (key === prev) continue
		prev = key
		out.push(event)
	}
	return out
}
