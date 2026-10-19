import { resolveTimeRangeAt, snapTimestamp } from "@maple/web-data/lib/time-range"
import { Clock, Effect, Schema } from "effect"

/** A resolved warehouse window, as every warehouse request carries it. */
export const TimeWindow = Schema.Struct({ startTime: Schema.String, endTime: Schema.String })
export type TimeWindow = typeof TimeWindow.Type

export interface WindowRequest {
	readonly startTime?: string | undefined
	readonly endTime?: string | undefined
	readonly preset: string
	/** False after an explicit refresh: legacy re-resolves against the real clock then. */
	readonly snap: boolean
	readonly timeZone?: string | undefined
}

/**
 * apps/web's `resolveEffectiveTimeRange` plus the 15 s key snap legacy applies when it decodes an
 * atom key back into the request, so the window sent is byte-identical to its execute-batch payload.
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
