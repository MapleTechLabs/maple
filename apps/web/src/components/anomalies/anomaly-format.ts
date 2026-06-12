import type {
	AnomalyIncidentDocument,
	AnomalyResolveReason,
	AnomalySignalType,
	AnomalyTriageStatus,
} from "@maple/domain/http"
import {
	BoltIcon,
	ChartLineIcon,
	CircleWarningIcon,
	FileIcon,
	PulseIcon,
} from "@/components/icons"

export const SIGNAL_LABEL: Record<AnomalySignalType, string> = {
	error_rate: "Error rate",
	latency_p95: "p95 latency",
	throughput: "Throughput",
	error_spike: "Error spike",
	log_volume: "Log volume",
}

export const SIGNAL_ICON: Record<AnomalySignalType, typeof PulseIcon> = {
	error_rate: CircleWarningIcon,
	latency_p95: ChartLineIcon,
	throughput: PulseIcon,
	error_spike: BoltIcon,
	log_volume: FileIcon,
}

export function formatSignalValue(signalType: AnomalySignalType, value: number): string {
	switch (signalType) {
		case "error_rate":
			return `${(value * 100).toFixed(1)}%`
		case "latency_p95":
			return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(0)}ms`
		case "throughput":
		case "log_volume":
			return `${value.toFixed(1)}/min`
		case "error_spike":
			return `${Math.round(value)} in 30m`
	}
}

export interface AnomalyDeviation {
	readonly sigma: number | null
	readonly ratio: number | null
	/** Canonical short label, e.g. "+3.2σ" or "4.1× baseline". */
	readonly label: string
}

/**
 * One canonical deviation figure used by rows, hero, and sidebar so the
 * numbers never disagree between surfaces.
 */
export function deviation(
	incident: Pick<AnomalyIncidentDocument, "lastObservedValue" | "baselineMedian" | "baselineSigma">,
): AnomalyDeviation {
	const delta = incident.lastObservedValue - incident.baselineMedian
	if (incident.baselineSigma > 0) {
		const sigma = delta / incident.baselineSigma
		const sign = sigma >= 0 ? "+" : ""
		return { sigma, ratio: null, label: `${sign}${sigma.toFixed(1)}σ` }
	}
	if (incident.baselineMedian > 0) {
		const ratio = incident.lastObservedValue / incident.baselineMedian
		return { sigma: null, ratio, label: `${ratio.toFixed(1)}× baseline` }
	}
	return { sigma: null, ratio: null, label: "new signal" }
}

export interface SeverityTone {
	/** Badge/chip classes, e.g. "bg-destructive/10 text-destructive". */
	readonly badge: string
	/** Solid accent (left bar, dots). */
	readonly accent: string
	/** Plain text tone. */
	readonly text: string
}

export const SEVERITY_TONE: Record<"critical" | "warning" | "resolved", SeverityTone> = {
	critical: {
		badge: "bg-destructive/10 text-destructive",
		accent: "bg-destructive",
		text: "text-destructive",
	},
	warning: {
		badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
		accent: "bg-amber-500",
		text: "text-amber-600 dark:text-amber-400",
	},
	resolved: {
		badge: "bg-muted text-muted-foreground",
		accent: "bg-border/60",
		text: "text-muted-foreground",
	},
}

export function severityToneFor(
	incident: Pick<AnomalyIncidentDocument, "status" | "severity">,
): SeverityTone {
	if (incident.status !== "open") return SEVERITY_TONE.resolved
	return SEVERITY_TONE[incident.severity]
}

export const RESOLVE_REASON_LABEL: Record<AnomalyResolveReason, string> = {
	returned_to_baseline: "Returned to baseline",
	no_data: "No data",
	manual: "Resolved manually",
}

export const TRIAGE_STATUS_CHIP: Record<
	AnomalyTriageStatus,
	{ label: string; tone: string } | null
> = {
	none: null,
	pending: { label: "triaging…", tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
	completed: { label: "triaged", tone: "bg-success/10 text-success" },
	skipped: { label: "triage skipped", tone: "bg-muted text-muted-foreground" },
}
