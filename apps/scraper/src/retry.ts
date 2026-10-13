import { Schedule } from "effect"

/**
 * Two retries with jittered exponential backoff (about 0.5s, then 1s) for Maple's own outbound
 * calls, so a dropped connection or a deploy's brief 5xx is not reported as a failure.
 */
export const TRANSIENT_RETRY = Schedule.max([
	Schedule.jittered(Schedule.exponential("500 millis")),
	Schedule.recurs(2),
])

/** No status is a transport failure or timeout; 429 and 5xx are the server asking to try again. */
export const isTransientStatus = (status: number | null): boolean =>
	status === null || status === 429 || status >= 500
