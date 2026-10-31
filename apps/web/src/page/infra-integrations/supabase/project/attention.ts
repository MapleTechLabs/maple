import type { SupabaseAdvisorLint, SupabaseLogIssue, SupabaseProjectInsights } from "@maple/domain/http"
import { formatPercent } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { logSourceLabel, SATURATION } from "../health"

// "Needs attention": advisor findings, recurring error logs and connection saturation, worst first.

export interface AttentionItem {
	readonly key: string
	/** The eyebrow: Security, Performance, Errors or Saturation. */
	readonly label: string
	readonly tone: Tone
	readonly title: string
	readonly detail: string
	/** When the item last happened, for the "last 09:41" suffix; `null` when not timed. */
	readonly lastSeen: string | null
}

export type AttentionInputs = Readonly<{
	/** `null` while the advisors have not loaded (or failed). */
	insights: SupabaseProjectInsights | null
	issues: ReadonlyArray<SupabaseLogIssue>
	/** Peak backends in the window against `max_connections`; `null` without metrics. */
	connections: Readonly<{ peak: number; limit: number | null }> | null
}>

/** Severity numbers from ERROR (17) up. */
const ERROR_SEVERITY = 17
/** The panel's one budget, applied after ranking so a milder item never displaces a worse one. */
export const MAX_ATTENTION_ITEMS = 6

const advisorItem = (lint: SupabaseAdvisorLint): AttentionItem => ({
	key: `advisor:${lint.cacheKey}`,
	label: lint.advisor === "security" ? "Security" : "Performance",
	tone: lint.level === "ERROR" ? "crit" : "warn",
	title: lint.title,
	detail: `Advisor · ${lint.detail.replaceAll("`", "")}`,
	lastSeen: null,
})

const issueItem = (issue: SupabaseLogIssue): AttentionItem => ({
	key: `log:${issue.source}:${issue.message}`,
	label: "Errors",
	tone: "crit",
	title: `${issue.message} (${issue.count}×)`,
	detail: `${logSourceLabel(issue.source)} logs`,
	lastSeen: issue.lastSeen,
})

const saturationItem = (peak: number, limit: number): AttentionItem => ({
	key: "saturation:connections",
	label: "Saturation",
	tone: "warn",
	title: `Connections hit ${Math.round(peak)} / ${limit}`,
	detail: `${formatPercent(peak / limit)} of max_connections`,
	lastSeen: null,
})

/** Advisor errors, error logs, saturation, then advisor warnings; uncapped, the panel shows the first `MAX_ATTENTION_ITEMS`. */
export const needsAttention = (inputs: AttentionInputs): ReadonlyArray<AttentionItem> => {
	const advisors = inputs.insights?.advisors
	const logs = inputs.issues.filter((issue) => issue.maxSeverity >= ERROR_SEVERITY).map(issueItem)
	const connections = inputs.connections
	const saturation =
		connections !== null &&
		connections.limit !== null &&
		connections.peak >= connections.limit * SATURATION
			? [saturationItem(connections.peak, connections.limit)]
			: []
	return [
		...(advisors?.error ?? []).map(advisorItem),
		...logs,
		...saturation,
		...(advisors?.warn ?? []).map(advisorItem),
	]
}
