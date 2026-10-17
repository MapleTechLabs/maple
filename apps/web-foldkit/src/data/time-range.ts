import {
	isCalendarAlignedShorthand,
	resolveRelativeRangeToWarehouse,
	snapRangeForCache,
} from "@maple/query-engine"
import { Clock, Effect, Schema } from "effect"

/** A resolved warehouse window, as every warehouse request carries it. */
export const TimeWindow = Schema.Struct({ startTime: Schema.String, endTime: Schema.String })
export type TimeWindow = typeof TimeWindow.Type

/** apps/web's `snapTimestamp` (`lib/time-utils.ts`): the 15 s floor its cache keys apply. */
const KEY_SNAP_SECONDS = 15
const snapTimestamp = (value: string): string => {
	if (value.length !== 19 || value[4] !== "-" || value[10] !== " ") return value
	const seconds = Number.parseInt(value.slice(17, 19), 10)
	if (Number.isNaN(seconds)) return value
	return value.slice(0, 17) + String(seconds - (seconds % KEY_SNAP_SECONDS)).padStart(2, "0")
}

export interface WindowRequest {
	readonly startTime?: string | undefined
	readonly endTime?: string | undefined
	readonly preset: string
	/** False after an explicit refresh: legacy re-resolves against the real clock then. */
	readonly snap: boolean
	readonly timeZone?: string | undefined
}

/**
 * `resolveEffectiveTimeRange` plus the key snap legacy applies when it decodes an atom key back
 * into the request, so the window sent here is byte-identical to apps/web's execute-batch payload.
 */
export const resolveWindow = (request: WindowRequest, nowMs: number): TimeWindow => {
	const explicit =
		request.startTime && request.endTime
			? { startTime: request.startTime, endTime: request.endTime }
			: undefined
	const relative =
		resolveRelativeRangeToWarehouse(request.preset, nowMs, request.timeZone) ??
		resolveRelativeRangeToWarehouse("12h", nowMs, request.timeZone)
	const resolved =
		explicit ??
		(relative === null || !request.snap
			? relative
			: snapRangeForCache(relative, { anchoredStart: isCalendarAlignedShorthand(request.preset) }))
	const window = resolved ?? { startTime: "", endTime: "" }
	return { startTime: snapTimestamp(window.startTime), endTime: snapTimestamp(window.endTime) }
}

/** Reads the clock, so it runs in a Command, never in `update`. */
export const currentWindow = (request: WindowRequest): Effect.Effect<TimeWindow> =>
	Effect.map(Clock.currentTimeMillis, (nowMs) => resolveWindow(request, nowMs))
