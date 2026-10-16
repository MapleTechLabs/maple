// Utilization (0..1 fraction of a capacity) → tone. One threshold pair for CPU,
// memory, disk and connection gauges: >= 90% is critical, >= 60% is a warning.

import type { Tone } from "./tone"

export const UTILIZATION_CRIT = 0.9
export const UTILIZATION_WARN = 0.6

export type UtilizationLevel = Extract<Tone, "ok" | "warn" | "crit">

/** Non-finite input reads as "ok" so a missing gauge recedes instead of alarming. */
export function utilizationLevel(fraction: number): UtilizationLevel {
	if (!Number.isFinite(fraction)) return "ok"
	if (fraction >= UTILIZATION_CRIT) return "crit"
	if (fraction >= UTILIZATION_WARN) return "warn"
	return "ok"
}
