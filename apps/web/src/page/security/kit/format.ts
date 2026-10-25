import { formatCost } from "@maple/agent-sessions"
import type { SecurityAuditFinding, SecurityAuditRun, SecurityAuditTarget } from "@maple/domain/http"
import {
	ORG_NO_AI_CREDITS,
	ORG_SPEND_LIMIT_REACHED,
	securityAuditModelOption,
	type SecurityAuditFindingStatus,
	type SecurityAuditProfile,
	type SecurityAuditRunKind,
	type SecurityAuditRunStatus,
	type SecurityAuditSeverity,
	type SecurityAuditVerdict,
} from "@maple/domain/security-audit"
import type { Tone } from "@maple/ui/lib/tone"
import { shortId as shortDisplayId } from "@maple/ui/lib/ids"
import { DateTime } from "effect"
import type { LoadFailure } from "../../../data/load-failure"

// Labels, tones and small derivations every Security Center view shares.

export type FindingRecord = SecurityAuditFinding["record"]

/** A 403 the page renders as a calm state rather than an error. */
export type Gate = "disabled" | "forbidden"

export const gateOf = (failure: LoadFailure): Gate | null =>
	failure.code === "security_audit_disabled"
		? "disabled"
		: failure.code === "security_audit_forbidden"
			? "forbidden"
			: null

const RUN_STATUS_LABEL = {
	in_progress: "Running",
	complete: "Complete",
	incomplete: "Incomplete",
	failed: "Failed",
} satisfies Record<SecurityAuditRunStatus, string>

/** A run is live until it has a finish time; status alone can change first. */
export const isLive = (run: Pick<SecurityAuditRun, "finishedAt">): boolean => run.finishedAt === null

/** A cancelled run is stored as `incomplete` with this reason. */
const CANCELLED_REASON = "cancelled"

export const isCancelled = (run: Pick<SecurityAuditRun, "status" | "incompleteReason">): boolean =>
	run.status === "incomplete" && run.incompleteReason === CANCELLED_REASON

const RUN_STATUS_TONE = {
	in_progress: "done",
	complete: "ok",
	incomplete: "warn",
	failed: "crit",
} satisfies Record<SecurityAuditRunStatus, Tone>

/** The status a person reads: a cancelled run is not a coverage gap. */
export const runLabelOf = (run: Pick<SecurityAuditRun, "status" | "incompleteReason">): string =>
	isCancelled(run) ? "Cancelled" : RUN_STATUS_LABEL[run.status]

export const runToneOf = (run: Pick<SecurityAuditRun, "status" | "incompleteReason">): Tone =>
	isCancelled(run) ? "neutral" : RUN_STATUS_TONE[run.status]

export const PROFILE_LABEL = {
	quick: "quick",
	standard: "standard",
	deep: "deep",
} satisfies Record<SecurityAuditProfile, string>

export const RUN_KIND_LABEL = {
	baseline: "Baseline",
	slice: "Slice",
	revalidation: "Revalidation",
	manual: "Manual",
} satisfies Record<SecurityAuditRunKind, string>

export const FINDING_STATUS_LABEL = {
	open: "Open",
	fixed: "Fixed",
	dismissed: "Dismissed",
	accepted_risk: "Accepted risk",
} satisfies Record<SecurityAuditFindingStatus, string>

/** The Findings tab's status filter: the four statuses and "All". */
export const STATUS_TAB_LABEL = { ...FINDING_STATUS_LABEL, all: "All" } as const

export const REPORT_TITLE = {
	report: "REPORT.md",
	findingsDetail: "FINDINGS-DETAIL.md",
	needsValidation: "NEEDS-VALIDATION.md",
} as const
export type ReportDoc = keyof typeof REPORT_TITLE

export const VERDICT_LABEL = {
	confirmed: "Confirmed",
	needs_validation: "Needs validation",
	rejected: "Rejected",
} satisfies Record<SecurityAuditVerdict, string>

export const SECURITY_SEVERITY_ORDER: ReadonlyArray<SecurityAuditSeverity> = [
	"critical",
	"high",
	"medium",
	"low",
	"informational",
]

export const SECURITY_SEVERITY_LABEL = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	informational: "Info",
} satisfies Record<SecurityAuditSeverity, string>

/** Sort rank: critical first, no severity (needs validation, rejected) last. */
export const severityRank = (severity: SecurityAuditSeverity | null): number =>
	severity === null ? SECURITY_SEVERITY_ORDER.length : SECURITY_SEVERITY_ORDER.indexOf(severity)

/** The errors kit's four levels; informational shares the unset glyph. */
export const issueSeverityOf = (severity: SecurityAuditSeverity | null) =>
	severity === null || severity === "informational" ? null : severity

export const formatUsd = (usd: number | null): string => (usd === null ? "not reported" : formatCost(usd))

/** What a run charged in AI credits so far, models and sandbox; null while it has charged nothing. */
export const runTotalUsd = (run: Pick<SecurityAuditRun, "costUsd" | "sandboxUsd">): number | null =>
	run.costUsd === null && run.sandboxUsd === 0 ? null : (run.costUsd ?? 0) + run.sandboxUsd

/** The engine's run id is long; the first block is what people say out loud. */
export const shortId = (id: string): string => id.replace(/^run[_-]/u, "").slice(0, 8)

/** A commit as its short SHA; a branch name the run resolved nothing for stays as written. */
export const refLabel = (ref: string): string =>
	/^[0-9a-f]{12,40}$/u.test(ref) ? shortDisplayId(ref, "sha") : ref

export const scopeLabel = (scopePaths: ReadonlyArray<string>): string =>
	scopePaths.length === 0
		? "all paths"
		: scopePaths.length === 1
			? (scopePaths[0] ?? "")
			: `${scopePaths.length} scope paths`

/** Branch, profile and scope; a whole-repo scope is the default and says nothing, so it is left off. */
export const targetLine = (target: SecurityAuditTarget): string =>
	[
		target.branch,
		PROFILE_LABEL[target.profile],
		...(target.scopePaths.length === 0 ? [] : [scopeLabel(target.scopePaths)]),
	].join(" · ")

/** A model's name from the catalogue; an id it no longer lists reads as the id. */
export const modelLabel = (id: string): string => securityAuditModelOption(id)?.label ?? id

/** Why the host or engine stopped a run, as a person reads it; unknown reasons stay as written. */
const INCOMPLETE_REASON_LABEL = new Map<string, string>([
	[ORG_SPEND_LIMIT_REACHED, "reached the monthly spend limit"],
	[ORG_NO_AI_CREDITS, "the organization ran out of AI credits"],
	["org_budget_unavailable", "spend could not be checked"],
	["cancelled", "cancelled"],
])

export const incompleteReasonLabel = (reason: string | null): string =>
	reason === null
		? "stopped early"
		: reason
				.split("; ")
				.map((part) => INCOMPLETE_REASON_LABEL.get(part) ?? part.replaceAll("_", " "))
				.join("; ")

/** The org's limit stopped the run: an admin can raise it and run again. */
export const isSpendLimitStop = (run: Pick<SecurityAuditRun, "incompleteReason">): boolean =>
	run.incompleteReason?.split("; ").includes(ORG_SPEND_LIMIT_REACHED) === true

/** `1h 12m`, `3h 41m`, `48s`: how long a run has taken (or took). */
export const formatElapsed = (ms: number): string => {
	const seconds = Math.max(0, Math.round(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

export const runElapsed = (run: SecurityAuditRun, nowMs: number): number =>
	(run.finishedAt ?? nowMs) - run.startedAt

/** Where a finding's code lives: the first trace step, else the first evidence line. */
export const locationOf = (record: FindingRecord): string | null => {
	const step = record.trace[0] ?? record.evidence[0]
	return step === undefined ? null : `${step.file}:${step.line}`
}

/** The month a run started in, for "spend this month". */
export const isSameMonth = (epochMs: number, nowMs: number): boolean => {
	const a = DateTime.toPartsUtc(DateTime.makeUnsafe(epochMs))
	const b = DateTime.toPartsUtc(DateTime.makeUnsafe(nowMs))
	return a.year === b.year && a.month === b.month
}

/** The machine-readable instant a `title` or `datetime` carries. */
export const isoOf = (epochMs: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMs))

/** `14:32:08` in the reader's zone: the event log's clock. */
export const formatClock = (epochMs: number, timeZone: string): string =>
	new Intl.DateTimeFormat("en-GB", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).format(epochMs)
