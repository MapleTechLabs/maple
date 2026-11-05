import { Array as Arr } from "effect"
import { resolveWindow, type TimeWindow, type WindowRequest } from "../../data/time-range"
import { PRESET_VALUES } from "../kit/time-range-picker"

// The users pages read the hourly per-user rollup, so their window starts on a UTC hour: the
// rollup's totals and the raw Traces and Logs tabs then cover the same span.

/** The window's start floored to its UTC hour (warehouse strings are `YYYY-MM-DD HH:MM:SS` UTC). */
export const hourAlignedWindow = (window: TimeWindow): TimeWindow => ({
	startTime: window.startTime.length === 19 ? `${window.startTime.slice(0, 14)}00:00` : window.startTime,
	endTime: window.endTime,
})

export const resolveUsersWindow = (request: WindowRequest, nowMs: number): TimeWindow =>
	hourAlignedWindow(resolveWindow(request, nowMs))

/** The picker's presets an hourly read can answer. */
export const USERS_PRESETS = Arr.filter(PRESET_VALUES, (preset) => !["5m", "15m", "30m"].includes(preset))
