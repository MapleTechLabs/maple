import type { AnomalyIncidentDocument, AnomalySignalType, AnomalyTriageStatus } from "@maple/domain/http"
import { TONE_FILL, TONE_SOFT, TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import type { IconName } from "../ui/icon"

// How an anomaly draws: its signal glyph, severity tone, triage chip and meta pill size.

/** The glyph each signal draws. */
export const SIGNAL_ICON_NAME = {
	error_rate: "CircleWarningIcon",
	latency_p95: "ChartLineIcon",
	throughput: "PulseIcon",
	error_spike: "BoltIcon",
	log_volume: "FileIcon",
} as const satisfies Record<AnomalySignalType, IconName>

export interface SeverityTone {
	/** Badge/chip classes, e.g. TONE_SOFT.crit. */
	readonly badge: string
	/** Solid accent (left bar, dots). */
	readonly accent: string
	/** Plain text tone. */
	readonly text: string
	/** The shared status tone, for `statusDot`. */
	readonly tone: Tone
}

const severityToneOf = (tone: Tone): SeverityTone => ({
	badge: TONE_SOFT[tone],
	accent: TONE_FILL[tone],
	text: TONE_TEXT[tone],
	tone,
})

export const SEVERITY_TONE: Record<"critical" | "warning" | "resolved", SeverityTone> = {
	critical: severityToneOf("crit"),
	warning: severityToneOf("warn"),
	resolved: severityToneOf("done"),
} satisfies Record<"critical" | "warning" | "resolved", SeverityTone>

export function severityToneFor(
	incident: Pick<AnomalyIncidentDocument, "status" | "severity">,
): SeverityTone {
	if (incident.status !== "open") return SEVERITY_TONE.resolved
	return SEVERITY_TONE[incident.severity]
}

type TriageChip = { label: string; variant: "warn" | "ok" | "muted" }

/** The triage status chip: its label and the badge variant it draws in. */
export const TRIAGE_STATUS_CHIP: Record<AnomalyTriageStatus, TriageChip | null> = {
	none: null,
	pending: { label: "triaging…", variant: "warn" },
	completed: { label: "triaged", variant: "ok" },
	skipped: { label: "triage skipped", variant: "muted" },
} satisfies Record<AnomalyTriageStatus, TriageChip | null>

/** Keeps the 20px / 11px meta-pill size on anomaly rows and cards (Badge `size="sm"` shrinks on sm+). */
export const META_CHIP_CLASS = "h-5 gap-1.5 font-normal text-2xs sm:h-5 sm:text-2xs"
