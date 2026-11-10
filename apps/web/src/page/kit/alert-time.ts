import { DateTime, Option } from "effect"

/** `Date.parse(iso)` (lint-banned): epoch ms, `NaN` for an unparsable string as `Date.parse` gives. */
export const isoMs = (iso: string): number =>
	Option.match(DateTime.make(iso), { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis })

/** `new Date(ms).toISOString()`. */
export const msIso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms))

/** `6m`, `3h 12m`, `2d 4h`: the two largest units of a span. */
export const formatSpan = (ms: number): string => {
	const seconds = Math.max(0, Math.floor(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
	const days = Math.floor(hours / 24)
	return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

/** A check cadence after "every": `minute`, or `5 min`. */
export const everyMinutes = (minutes: number): string => (minutes === 1 ? "minute" : `${minutes} min`)
