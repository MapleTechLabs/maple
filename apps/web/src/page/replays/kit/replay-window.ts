import { formatWarehouseDateTime, warehouseDateTimeToIso } from "@maple/query-engine"
import { DateTime, Option, Schema } from "effect"

// The warehouse-coupled half of the replay format: the partition window and the SDK's markers.

export interface ReplayPartitionWindow {
	readonly windowStart: string
	readonly windowEnd: string
}

const WINDOW_MARGIN_MS = 60 * 60 * 1000
/** Must stay >= the browser SDK's session lifetime cap (`MAX_SESSION_MS`). */
const MAX_SESSION_MS = 24 * 60 * 60 * 1000

const epochOf = (warehouseTime: string): Option.Option<number> =>
	Option.map(DateTime.make(warehouseDateTimeToIso(warehouseTime)), DateTime.toEpochMillis)

/** `replayPartitionWindow`: the session's span plus slack, from the `t` hint. */
export const replayPartitionWindow = (
	startHint: string | undefined,
	endHint?: string,
): ReplayPartitionWindow | undefined => {
	if (startHint === undefined || startHint === "") return undefined
	return Option.match(epochOf(startHint), {
		onNone: () => undefined,
		onSome: (startMs) => {
			const endMs = endHint === undefined || endHint === "" ? Option.none<number>() : epochOf(endHint)
			const upperMs = Option.match(endMs, {
				onNone: () => startMs + MAX_SESSION_MS,
				onSome: (end) => end + WINDOW_MARGIN_MS,
			})
			return {
				windowStart: formatWarehouseDateTime(startMs - WINDOW_MARGIN_MS),
				windowEnd: formatWarehouseDateTime(upperMs),
			}
		},
	})
}

const decodeAttributes = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

/** A string-valued resource attribute; anything else reads as absent. */
const attributeOf = (resourceAttributes: string | null | undefined, key: string): string | undefined =>
	resourceAttributes === null || resourceAttributes === undefined || resourceAttributes === ""
		? undefined
		: Option.match(decodeAttributes(resourceAttributes), {
				onNone: () => undefined,
				onSome: (parsed) => {
					const value = parsed[key]
					return typeof value === "string" ? value : undefined
				},
			})

/** `recordedMarker`: the SDK's `maple.session.recorded`, or undefined when unknown. */
export const recordedMarker = (resourceAttributes: string | null | undefined): boolean | undefined => {
	const marker = attributeOf(resourceAttributes, "maple.session.recorded")
	return marker === "true" ? true : marker === "false" ? false : undefined
}

export type ReplayFormat = "rrweb" | "video"

/** `replayFormat`: which engine plays the session; unknown falls back to rrweb. */
export const replayFormat = (resourceAttributes: string | null | undefined): ReplayFormat =>
	attributeOf(resourceAttributes, "maple.session.replay_format") === "video" ? "video" : "rrweb"
