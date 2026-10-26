import type { ErrorIssueEventDocument } from "@maple/domain/http"
import { countLabel, formatRatePerHour } from "@maple/ui/lib/format"
import { AGENT_ACCENT, TONE_FILL } from "@maple/ui/lib/tone"
import { DateTime, Option } from "effect"

// The issue timeline's vocabulary: labels, dots, payload text.

export type EventType = ErrorIssueEventDocument["type"]

export const IN_FLIGHT_FILL = "bg-severity-debug"

export const EVENT_LABEL = {
	created: "Created",
	state_change: "State change",
	assignment: "Assignment",
	claim: "Claimed",
	release: "Released",
	lease_expired: "Lease expired",
	comment: "Comment",
	agent_note: "Agent note",
	fix_proposed: "Fix proposed",
	regression: "Regression",
	snooze: "Snoozed",
	unsnooze: "Unsnoozed",
	ai_triage: "AI triage",
	anomaly_linked: "Anomaly",
	severity_change: "Severity",
	pr_linked: "PR linked",
	pr_unlinked: "PR unlinked",
	pr_merged: "PR merged",
	verification_started: "Verifying fix",
	verification_verdict: "Verification",
} satisfies Record<EventType, string>

export const DOT_CLASS = {
	created: "bg-primary",
	state_change: IN_FLIGHT_FILL,
	assignment: "bg-muted-foreground",
	claim: AGENT_ACCENT.fill,
	release: "bg-chart-ai-agent/60",
	lease_expired: TONE_FILL.warn,
	comment: "bg-muted-foreground",
	agent_note: AGENT_ACCENT.fill,
	fix_proposed: TONE_FILL.ok,
	regression: TONE_FILL.crit,
	snooze: "bg-muted-foreground/70",
	unsnooze: "bg-muted-foreground/70",
	ai_triage: AGENT_ACCENT.fill,
	anomaly_linked: TONE_FILL.warn,
	severity_change: TONE_FILL.warn,
	pr_linked: "bg-muted-foreground",
	pr_unlinked: "bg-muted-foreground/60",
	pr_merged: TONE_FILL.ok,
	verification_started: IN_FLIGHT_FILL,
	verification_verdict: IN_FLIGHT_FILL,
} satisfies Record<EventType, string>

export const MESSAGE_TYPES: ReadonlySet<EventType> = new Set([
	"comment",
	"agent_note",
	"ai_triage",
	"fix_proposed",
	"verification_verdict",
])

export const MESSAGE_VERB = {
	created: null,
	state_change: null,
	assignment: null,
	claim: null,
	release: null,
	lease_expired: null,
	comment: null,
	agent_note: "left a note",
	fix_proposed: "proposed a fix",
	regression: null,
	snooze: null,
	unsnooze: null,
	ai_triage: "triaged this",
	anomaly_linked: null,
	severity_change: null,
	pr_linked: null,
	pr_unlinked: null,
	pr_merged: null,
	verification_started: null,
	verification_verdict: "checked the fix",
} satisfies Record<EventType, string | null>

/** `payloadString`: a scalar as text; anything else as JSON. */
export const payloadString = (value: unknown): string | null => {
	if (value === null || value === undefined) return null
	if (typeof value === "string") return value
	if (typeof value === "number" || typeof value === "boolean") return String(value)
	return JSON.stringify(value) ?? null
}

/** "6 hours", "3 days": a duration a person would say out loud. */
export const formatSpokenDuration = (ms: number): string => {
	const minutes = Math.round(ms / 60_000)
	if (minutes < 60) return countLabel(minutes, "minute")
	const hours = Math.round(minutes / 60)
	if (hours < 48) return countLabel(hours, "hour")
	return countLabel(Math.round(hours / 24), "day")
}

export const isoMs = (iso: string): number =>
	Option.getOrElse(Option.map(DateTime.make(iso), DateTime.toEpochMillis), () => Number.NaN)

type Payload = Readonly<Record<string, unknown>>

const prReference = (p: Payload): string | null => {
	const repo = payloadString(p.repoFullName)
	const number = payloadString(p.number)
	if (!repo || !number) return payloadString(p.url)
	const source = payloadString(p.source)
	const via =
		source === "auto" ? " (referenced in the pull request)" : source === "agent" ? " by an agent" : ""
	return `${repo}#${number}${via}`
}

const severityChange = (p: Payload): string => {
	const source = payloadString(p.source)
	const confidence = payloadString(p.confidence)
	const note = payloadString(p.note)
	const suffix =
		source === "ai"
			? ` by AI triage${confidence ? ` (${confidence} confidence)` : ""}`
			: source === "detector"
				? " from detector"
				: ""
	return `${payloadString(p.from) ?? "unset"} → ${payloadString(p.to) ?? "unset"}${suffix}${note ? `: ${note}` : ""}`
}

const verificationStarted = (p: Payload): string => {
	const windowMs = Number(payloadString(p.windowMs) ?? Number.NaN)
	const rate = Number(payloadString(p.ratePerHour) ?? Number.NaN)
	if (!Number.isFinite(windowMs)) return "Watching for this error to come back."
	const because =
		Number.isFinite(rate) && rate > 0
			? `. It fired about ${formatRatePerHour(rate)} before the merge`
			: ". This error fires too rarely to judge quickly"
	return `Watching for ${formatSpokenDuration(windowMs)}${because}.`
}

const verdictText = (p: Payload): string => {
	const value = payloadString(p.verdict)
	const note = payloadString(p.note)
	const headline =
		value === "verified"
			? p.autoClosed === true
				? "**The fix holds.** Closing this issue."
				: "**The fix holds.** Leaving it open for a human to close."
			: value === "not_fixed"
				? "**The error is still happening.** Reopening this issue."
				: "**Could not tell yet.**"
	return note ? `${headline}\n\n${note}` : headline
}

/** `renderPayload`: the row's body text, or none. */
export const renderPayload = (event: ErrorIssueEventDocument): string | null => {
	const p = event.payload
	switch (event.type) {
		case "comment":
		case "agent_note":
			return payloadString(p.body)
		case "fix_proposed": {
			const summary = payloadString(p.patchSummary) ?? ""
			const url = payloadString(p.prUrl)
			return url ? `${summary}: ${url}` : summary
		}
		case "claim": {
			const expires = payloadString(p.leaseExpiresAt)
			return expires ? `lease expires at ${new Date(Number(expires)).toISOString()}` : null
		}
		case "state_change":
			return payloadString(p.note)
		case "ai_triage":
			return payloadString(p.summary)
		case "anomaly_linked": {
			const action = payloadString(p.action) === "unlinked" ? "Unlinked from" : "Linked to"
			const signal = payloadString(p.signalType)
			const service = payloadString(p.serviceName)
			return signal && service ? `${action} a ${signal} anomaly on ${service}` : null
		}
		case "severity_change":
			return severityChange(p)
		case "pr_linked":
		case "pr_unlinked":
			return prReference(p)
		case "pr_merged": {
			const repo = payloadString(p.repoFullName)
			const number = payloadString(p.number)
			return repo && number ? `${repo}#${number} merged` : payloadString(p.url)
		}
		case "verification_started":
			return verificationStarted(p)
		case "verification_verdict":
			return verdictText(p)
		default:
			return null
	}
}

/** Two messages from one author within five minutes read as one turn. */
const CONTINUATION_WINDOW_MS = 5 * 60 * 1000

export const isContinuation = (
	previous: ErrorIssueEventDocument | null,
	event: ErrorIssueEventDocument,
): boolean => {
	if (previous === null || !MESSAGE_TYPES.has(previous.type) || previous.type !== event.type) return false
	const previousActor = previous.actor?.id ?? null
	if (previousActor === null || previousActor !== (event.actor?.id ?? null)) return false
	return isoMs(event.createdAt) - isoMs(previous.createdAt) < CONTINUATION_WINDOW_MS
}
