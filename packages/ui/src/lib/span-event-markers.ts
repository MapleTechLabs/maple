// Span event markers on the trace timeline: where along its bar each event sits.

import { formatDuration } from "./format"

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
	/** Trace-relative time the marker sits at, like the bar's `--b0`/`--b1`; kept inside the span. */
	readonly atMs: number
	/** `+12ms`, or `-3ms` for an event stamped before its span started (clock skew). */
	readonly offsetLabel: string
	readonly isException: boolean
}

/**
 * Place events on the trace's time axis, so they are positioned like the bar itself rather
 * than inside its viewport-clamped box. Offsets outside the span (clock skew, or an event
 * recorded after `end()`) pin to the nearest edge rather than escaping it.
 */
export function spanEventMarkers(
	events: ReadonlyArray<TimelineSpanEvent>,
	spanStartMs: number,
	durationMs: number,
): ReadonlyArray<SpanEventMarker> {
	return events.map((event) => ({
		name: event.name,
		offsetMs: event.offsetMs,
		atMs: spanStartMs + Math.min(Math.max(durationMs, 0), Math.max(0, event.offsetMs)),
		offsetLabel: `${event.offsetMs < 0 ? "-" : "+"}${formatDuration(Math.abs(event.offsetMs))}`,
		isException: event.name === "exception",
	}))
}
