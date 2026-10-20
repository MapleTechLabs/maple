import { DateTime, Option } from "effect"

/** `Date.parse(iso)` (lint-banned): epoch ms, `NaN` for an unparsable string as `Date.parse` gives. */
export const isoMs = (iso: string): number =>
	Option.match(DateTime.make(iso), { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis })

/** `new Date(ms).toISOString()`. */
export const msIso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms))
