// Span events: zip the warehouse's parallel Events arrays into records.
//
// `traces` stores OTel span events as three parallel columns (EventsTimestamp,
// EventsName, EventsAttributes). `spanEventsQuery` returns each as a JSON array
// string; this turns them into one record per event with its offset from the
// span start. Driver-free so the API, MCP and web can share it.

import { Option, Schema } from "effect"
import { parseWarehouseDateTime, warehouseDateTimeToIso } from "./datetime"

export interface SpanEvent {
	readonly name: string
	/** ISO-8601 UTC, millisecond precision. */
	readonly timestamp: string
	/** Event time minus span start, in ms with sub-millisecond precision. */
	readonly offsetMs: number
	readonly attributes: Readonly<Record<string, string>>
}

export interface RawSpanEvents {
	readonly spanStart: string
	readonly eventsTimestamp: string
	readonly eventsName: string
	/** Absent when only times and names were read (timeline markers). */
	readonly eventsAttributes?: string
}

const decodeStrings = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))
const decodeAttributes = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.String))),
)

const DATETIME64_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?/

/**
 * A DateTime64(9) string as whole epoch ms plus the nanoseconds past that ms.
 * `Date.parse` alone would drop everything below a millisecond.
 */
const parseNanos = (value: string): Option.Option<{ readonly ms: number; readonly subMsNanos: number }> => {
	const match = DATETIME64_PATTERN.exec(value.trim())
	if (!match) return Option.none()
	const [, date, time, fraction = ""] = match
	const seconds = parseWarehouseDateTime(`${date} ${time}`)
	if (Number.isNaN(seconds)) return Option.none()
	const nanos = Number(fraction.padEnd(9, "0"))
	return Option.some({ ms: seconds + Math.floor(nanos / 1e6), subMsNanos: nanos % 1e6 })
}

/**
 * Zip the parallel arrays into events sorted by time. Undecodable input yields
 * no events rather than an error: events are supplementary to the span detail.
 */
export const parseSpanEvents = (raw: RawSpanEvents): ReadonlyArray<SpanEvent> => {
	const timestamps = Option.getOrElse(decodeStrings(raw.eventsTimestamp), () => [])
	const names = Option.getOrElse(decodeStrings(raw.eventsName), () => [])
	const attributes = Option.getOrElse(decodeAttributes(raw.eventsAttributes), () => [])
	const start = parseNanos(raw.spanStart)

	return timestamps
		.flatMap((value, index) =>
			Option.match(parseNanos(value), {
				onNone: () => [],
				onSome: (at) => [
					{
						name: names[index] ?? "",
						timestamp: warehouseDateTimeToIso(value),
						offsetMs: Option.match(start, {
							onNone: () => 0,
							onSome: (s) => at.ms - s.ms + (at.subMsNanos - s.subMsNanos) / 1e6,
						}),
						attributes: attributes[index] ?? {},
					},
				],
			}),
		)
		.sort((a, b) => a.offsetMs - b.offsetMs)
}
