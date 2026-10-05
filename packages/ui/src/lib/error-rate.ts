// Error-rate (0..1) → tone. One threshold pair for every table, map node and
// stat tile: >= 5% is critical, >= 1% is a warning, anything lower is quiet.

import { formatErrorRate } from "./format"
import { TONE_COLOR, TONE_FILL, TONE_TEXT, type Tone } from "./tone"

export const ERROR_RATE_CRIT = 0.05
export const ERROR_RATE_WARN = 0.01

export type ErrorRateLevel = Extract<Tone, "crit" | "warn" | "neutral">

export function errorRateLevel(rate: number): ErrorRateLevel {
	if (!Number.isFinite(rate) || rate <= 0) return "neutral"
	if (rate >= ERROR_RATE_CRIT) return "crit"
	if (rate >= ERROR_RATE_WARN) return "warn"
	return "neutral"
}

/** Quiet floor is `text-foreground/80` so a 0.3% still reads as a value, not a label. */
export const ERROR_RATE_TEXT: Record<ErrorRateLevel, string> = {
	crit: TONE_TEXT.crit,
	warn: TONE_TEXT.warn,
	neutral: "text-foreground/80",
} satisfies Record<ErrorRateLevel, string>

export const ERROR_RATE_FILL: Record<ErrorRateLevel, string> = {
	crit: TONE_FILL.crit,
	warn: TONE_FILL.warn,
	neutral: "bg-muted-foreground/30",
} satisfies Record<ErrorRateLevel, string>

export const ERROR_RATE_COLOR: Record<ErrorRateLevel, string> = {
	crit: TONE_COLOR.crit,
	warn: TONE_COLOR.warn,
	neutral: TONE_COLOR.neutral,
} satisfies Record<ErrorRateLevel, string>

export function errorRateClass(rate: number): string {
	return ERROR_RATE_TEXT[errorRateLevel(rate)]
}

export { formatErrorRate }
