import { resolveTimeRangeAt, snapTimestamp } from "@maple/web-data/lib/time-range"
import { Clock, Effect, Schema } from "effect"

/** A resolved warehouse window, as every warehouse request carries it. */
export const TimeWindow = Schema.Struct({ startTime: Schema.String, endTime: Schema.String })
export type TimeWindow = typeof TimeWindow.Type

export interface WindowRequest {
	readonly startTime?: string | undefined
	readonly endTime?: string | undefined
	readonly preset: string
	/** False after an explicit refresh, which re-resolves against the real clock. */
	readonly snap: boolean
	readonly timeZone?: string | undefined
}

/**
 * Resolves the effective time range, snapped to 15 s like the request key, so equal keys send
 * byte-identical windows.
 */
export const resolveWindow = (request: WindowRequest, nowMs: number): TimeWindow => {
	const window = resolveTimeRangeAt(nowMs, request.startTime, request.endTime, request.preset, {
		timeZone: request.timeZone,
		snap: request.snap,
	})
	return { startTime: snapTimestamp(window.startTime), endTime: snapTimestamp(window.endTime) }
}

/** Reads the clock, so it runs in a Command, never in `update`. */
export const currentWindow = (request: WindowRequest): Effect.Effect<TimeWindow> =>
	Effect.map(Clock.currentTimeMillis, (nowMs) => resolveWindow(request, nowMs))
