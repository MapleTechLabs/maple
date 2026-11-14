import { Option, Schedule } from "effect"
import { timestampMs } from "@maple/backend/platform/time"

/** Two jittered retries for a vendor call that failed on a passing upstream hiccup (a 5xx). */
export const VENDOR_TRANSIENT_RETRY = Schedule.max([
	Schedule.jittered(Schedule.exponential("500 millis")),
	Schedule.recurs(2),
])

/** A header holding a non-negative number of seconds, such as `x-ratelimit-reset` as a delta. */
export const parseDeltaSeconds = (header: string | undefined): Option.Option<number> => {
	const seconds = header === undefined ? Number.NaN : Number(header)
	return Number.isFinite(seconds) && seconds >= 0 ? Option.some(seconds) : Option.none()
}

/** `retry-after` in seconds: delta-seconds, or an HTTP-date counted from `nowMs`. */
export const parseRetryAfterSeconds = (header: string | undefined, nowMs: number): Option.Option<number> =>
	Option.orElse(parseDeltaSeconds(header), () => {
		const dateMs = header === undefined ? Number.NaN : timestampMs(header)
		return Number.isFinite(dateMs)
			? Option.some(Math.max(0, Math.ceil((dateMs - nowMs) / 1000)))
			: Option.none()
	})
