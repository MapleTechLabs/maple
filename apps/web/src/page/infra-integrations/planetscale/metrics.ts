import { VALUE_TONE } from "../../../components/infra/severity-tokens"
import type { Tone } from "@maple/ui/lib/tone"
import { utilizationLevel } from "@maple/ui/lib/utilization"

// A copy of apps/web/src/components/infra/planetscale/metrics.ts; keep the two in step.

/** Metrics missing for the window sort below every real value. */
export const MISSING = Number.NEGATIVE_INFINITY

export const utilizationTone = (percent: number): Tone => {
	const level = utilizationLevel(percent / 100)
	return level === "ok" ? "neutral" : level
}

export const lagTone = (seconds: number): Tone => {
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

export const formatLag = (seconds: number): string =>
	seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds * 1000)}ms`

export const formatStoragePercent = (percent: number): string =>
	`${percent >= 99.5 || percent < 10 ? percent.toFixed(1) : percent.toFixed(0)}%`

export const abnormalState = (state: string | null): string | null => {
	if (state === null) return null
	const normalized = state.toLowerCase()
	return normalized === "ready" || normalized === "active" ? null : normalized
}

export { formatWholePercent } from "../../../components/infra/format"
