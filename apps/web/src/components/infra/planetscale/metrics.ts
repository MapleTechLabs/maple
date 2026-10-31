// Thresholds, tones, and formatting for the PlanetScale metrics.
//
// Every PlanetScale surface (the fleet table, the branch table, the detail charts, the toolbar
// stats, the service-map panel) reads its severity from here. These gauges arrive as 0-100
// percentages; utilization divides them onto the shared 0-1 thresholds (`@maple/ui/lib/utilization`)
// so an 85% reads the same colour here as on every other infra gauge.

import { formatDuration } from "@maple/ui/lib/format"
import { type Tone, VALUE_TONE } from "../severity-tokens"
import { utilizationLevel } from "@maple/ui/lib/utilization"

/** Metrics missing for the window sort below every real value. */
export const MISSING = Number.NEGATIVE_INFINITY

/** Utilization percentage (0-100) to tone, on the shared fraction thresholds. Shared by CPU, memory, and storage. */
export function utilizationTone(percent: number): Tone {
	const level = utilizationLevel(percent / 100)
	return level === "ok" ? "neutral" : level
}

/** Replica lag in seconds to tone. A second of lag is already worth noticing. */
export function lagTone(seconds: number): Tone {
	if (!Number.isFinite(seconds)) return "neutral"
	if (seconds > 10) return "crit"
	if (seconds > 1) return "warn"
	return "neutral"
}

export const utilizationClass = (percent: number): string | undefined => {
	const tone = utilizationTone(percent)
	return tone === "neutral" ? undefined : VALUE_TONE[tone]
}

export const lagClass = (seconds: number): string | undefined => {
	const tone = lagTone(seconds)
	return tone === "neutral" ? undefined : VALUE_TONE[tone]
}

/** Replica lag reads in seconds once it is a real problem, milliseconds while it isn't. */
export const formatLag = (seconds: number): string => formatDuration(seconds * 1000)

/** Storage used as a whole percentage: the number people quote about a full disk. */
export const formatStoragePercent = (percent: number) =>
	`${percent >= 99.5 || percent < 10 ? percent.toFixed(1) : percent.toFixed(0)}%`

/** A branch state worth showing: anything but ready/active, lowercased. */
export const abnormalState = (state: string | null): string | null => {
	if (state === null) return null
	const normalized = state.toLowerCase()
	return normalized === "ready" || normalized === "active" ? null : normalized
}
