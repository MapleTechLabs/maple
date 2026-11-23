// High-resolution times as [seconds, nanoseconds], with the OTel JS SDK's rounding.
import type { HrTime, TimeInput } from "@opentelemetry/api"

const NANOS_PER_SECOND = 1_000_000_000

export function millisToHrTime(epochMillis: number): HrTime {
	return [Math.trunc(epochMillis / 1_000), Math.round((epochMillis % 1_000) * 1_000_000)]
}

export function addHrTimes(a: HrTime, b: HrTime): HrTime {
	const nanos = a[1] + b[1]
	return nanos >= NANOS_PER_SECOND ? [a[0] + b[0] + 1, nanos - NANOS_PER_SECOND] : [a[0] + b[0], nanos]
}

/** A `performance.now()` reading (now by default) as epoch time. */
export function hrTime(performanceNow: number = performance.now()): HrTime {
	return addHrTimes(millisToHrTime(performance.timeOrigin), millisToHrTime(performanceNow))
}

export function isHrTime(value: unknown): value is HrTime {
	return (
		Array.isArray(value) &&
		value.length === 2 &&
		typeof value[0] === "number" &&
		typeof value[1] === "number"
	)
}

export function isTimeInput(value: unknown): value is TimeInput {
	return isHrTime(value) || typeof value === "number" || value instanceof Date
}

/** Epoch ms, `performance.now()` ms (anything under half the time origin), a Date or an HrTime. */
export function timeInputToHrTime(time: TimeInput): HrTime {
	if (isHrTime(time)) return time
	if (typeof time === "number") {
		return time < performance.timeOrigin / 2 ? hrTime(time) : millisToHrTime(time)
	}
	return millisToHrTime(time.getTime())
}

export function hrTimeDuration(start: HrTime, end: HrTime): HrTime {
	const nanos = end[1] - start[1]
	return nanos < 0 ? [end[0] - start[0] - 1, nanos + NANOS_PER_SECOND] : [end[0] - start[0], nanos]
}

export function hrTimeToMillis(time: HrTime): number {
	return time[0] * 1_000 + time[1] / 1_000_000
}

/** Unix nanoseconds as the decimal string OTLP/JSON carries. */
export function hrTimeToNanosString(time: HrTime): string {
	return (BigInt(Math.trunc(time[0])) * 1_000_000_000n + BigInt(Math.trunc(time[1]))).toString()
}
