// Canonical severity/status → Tailwind class maps for the infrastructure UI.
// Keyed by the shared `SeverityLevel` / `HostStatus` unions from `./format`, so
// the severity palette lives in one place instead of being re-encoded per file.

import { TONE_COLOR, TONE_FILL, TONE_TEXT } from "@maple/ui/lib/tone"

import type { HostStatus, SeverityLevel } from "./format"

export type Tone = SeverityLevel | "neutral"

/** KPI value text tone (stat-rail, detail headers). */
export const VALUE_TONE: Record<Tone, string> = {
	neutral: "text-foreground",
	ok: "text-foreground",
	warn: TONE_TEXT.warn,
	crit: TONE_TEXT.crit,
} satisfies Record<Tone, string>

/** Sparkline fill — a raw CSS var string (consumed as an SVG `fill`, not a class). */
export const SPARK_COLOR: Record<Tone, string> = {
	neutral: "var(--primary)",
	ok: TONE_COLOR.ok,
	warn: TONE_COLOR.warn,
	crit: TONE_COLOR.crit,
} satisfies Record<Tone, string>

/** Solid severity fill for inline meter bars. */
export const BAR_FILL: Record<SeverityLevel, string> = {
	ok: TONE_FILL.ok,
	warn: TONE_FILL.warn,
	crit: TONE_FILL.crit,
} satisfies Record<SeverityLevel, string>

/** Dimmer value-text tone used inside compact bar widgets. */
export const BAR_VALUE_TONE: Record<SeverityLevel, string> = {
	ok: "text-foreground/75",
	warn: TONE_TEXT.warn,
	crit: TONE_TEXT.crit,
} satisfies Record<SeverityLevel, string>

/** Status dot fill. */
export const STATUS_DOT: Record<HostStatus, string> = {
	active: TONE_FILL.info,
	idle: "bg-muted-foreground/60",
	ended: "bg-muted-foreground/40",
} satisfies Record<HostStatus, string>

/** Status dot ring. */
export const STATUS_RING: Record<HostStatus, string> = {
	active: "ring-[color-mix(in_oklab,var(--severity-info)_45%,transparent)]",
	idle: "ring-border",
	ended: "ring-border",
} satisfies Record<HostStatus, string>

const STATUS_LABEL: Record<HostStatus, string> = {
	active: "Active",
	idle: "Idle",
	ended: "Ended",
} satisfies Record<HostStatus, string>

/** Human-readable status word, paired with color so it is never the sole signal. */
export function statusLabel(status: HostStatus): string {
	return STATUS_LABEL[status]
}
