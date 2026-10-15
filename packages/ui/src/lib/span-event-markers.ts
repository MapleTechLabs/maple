// Span event markers on the trace timeline: where along its bar each event sits.

/** One OTel span event as the timeline needs it: no attributes. */
export interface TimelineSpanEvent {
	readonly name: string
	/** Event time minus span start, in ms. */
	readonly offsetMs: number
}

/** Timeline events keyed by span id; spans without events are absent. */
export type SpanEventsBySpanId = ReadonlyMap<string, ReadonlyArray<TimelineSpanEvent>>

export interface SpanEventMarker {
	readonly name: string
	readonly offsetMs: number
	/** Position along the bar, 0-100. */
	readonly percent: number
	readonly isException: boolean
}

/**
 * Place events along a span's bar. Offsets outside the span (clock skew, or an
 * event recorded after `end()`) pin to the nearest edge rather than escaping it.
 */
export function spanEventMarkers(
	events: ReadonlyArray<TimelineSpanEvent>,
	durationMs: number,
): ReadonlyArray<SpanEventMarker> {
	return events.map((event) => ({
		name: event.name,
		offsetMs: event.offsetMs,
		percent: durationMs > 0 ? Math.min(100, Math.max(0, (event.offsetMs / durationMs) * 100)) : 0,
		isException: event.name === "exception",
	}))
}
