import type {
	StatusPageComponentStatus,
	StatusPageIncidentImpact,
	StatusPageIncidentStatus,
} from "@maple/domain/primitives"
import type { StatusPageDayBar, StatusPageDayState } from "@maple/domain/status-page"

export const COMPONENT_STATUS_LABEL = {
	operational: "Operational",
	maintenance: "Under maintenance",
	degraded: "Degraded performance",
	partial_outage: "Partial outage",
	major_outage: "Major outage",
} as const satisfies Record<StatusPageComponentStatus, string>

/** The banner sentence for the overall status. */
export const HERO_SENTENCE = {
	operational: "We're fully operational",
	maintenance: "Scheduled maintenance in progress",
	degraded: "We're experiencing degraded performance",
	partial_outage: "We're experiencing a partial outage",
	major_outage: "We're experiencing a major outage",
} as const satisfies Record<StatusPageComponentStatus, string>

export const INCIDENT_STATUS_LABEL = {
	investigating: "Investigating",
	identified: "Identified",
	monitoring: "Monitoring",
	resolved: "Resolved",
	scheduled: "Scheduled",
	in_progress: "In progress",
	completed: "Completed",
} as const satisfies Record<StatusPageIncidentStatus, string>

export const IMPACT_LABEL = {
	none: "No impact",
	minor: "Minor",
	major: "Major",
	critical: "Critical",
} as const satisfies Record<StatusPageIncidentImpact, string>

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const pad = (value: number): string => String(value).padStart(2, "0")

/** `Oct 28, 2026`, UTC: rendering at the edge must not depend on the colo's locale. */
export const formatDate = (ms: number): string => {
	const date = new Date(ms)
	return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`
}

/** `Oct 28, 2026, 14:05 UTC`. */
export const formatDateTime = (ms: number): string => {
	const date = new Date(ms)
	return `${formatDate(ms)}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

/** `YYYY-MM-DD` day of a bar, as `Oct 28, 2026`. */
export const formatDay = (day: string): string => {
	const [year = 1970, month = 1, date = 1] = day.split("-").map(Number)
	return formatDate(Date.UTC(year, month - 1, date))
}

/** `just now`, `4 min ago`, `3 h ago`, `2 d ago`. The inline page script mirrors this. */
export const formatAge = (ageMs: number): string => {
	const minutes = Math.floor(Math.max(0, ageMs) / 60_000)
	if (minutes < 1) return "just now"
	if (minutes < 60) return `${minutes} min ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 48) return `${hours} h ago`
	return `${Math.floor(hours / 24)} d ago`
}

/** Floors so a day with any downtime never reads as 100%. */
export const formatPercent = (percent: number): string => {
	// Rounds off float error first: 99.84 must not floor from 99.83999999999999.
	const floored = Math.floor(Number((percent * 100).toFixed(6))) / 100
	return `${floored.toFixed(2).replace(/\.?0+$/u, "")}%`
}

export const DAY_STATE_LABEL = {
	none: "No data",
	ok: "No downtime",
	degraded: "Some checks failed",
	down: "Downtime recorded",
} as const satisfies Record<StatusPageDayState, string>

/** The tooltip of one bar: the day and what happened on it. */
export const dayTitle = (bar: StatusPageDayBar, state: StatusPageDayState): string => {
	const detail =
		state === "none"
			? DAY_STATE_LABEL.none
			: state === "ok"
				? `${DAY_STATE_LABEL.ok}, ${bar.checks} checks`
				: state === "degraded"
					? `${bar.failures} of ${bar.checks} checks failed`
					: `Down during ${bar.downChecks} of ${bar.checks} checks`
	return `${formatDay(bar.day)}: ${detail}`
}
