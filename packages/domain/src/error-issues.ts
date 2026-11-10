// Stored shapes shared by the HTTP contract (`./http/errors.ts`) and the Postgres tables.

import { Schema } from "effect"

export const WorkflowState = Schema.Literals([
	"triage",
	// Set by the errors tick when a resolved issue starts firing again. Distinct
	// from `triage` on purpose: reopening into `triage` erased the fact that the
	// issue had ever been fixed, so the next person or agent to pick it up saw a
	// brand-new bug and fixed it again. Ordered second so it surfaces near the top
	// of the hub.
	"regressed",
	"todo",
	"in_progress",
	"in_review",
	// A linked pull request has merged and the fix is being confirmed against real
	// traffic. Machine-owned like `regressed`: entering it asserts an observation
	// (a merge landed) rather than an intention, and the verification tick owns
	// the exit. Ordered after `in_review` because that is where work flows from.
	"verifying",
	"done",
	"cancelled",
	"wontfix",
]).annotate({
	identifier: "@maple/WorkflowState",
	title: "Workflow State",
})
export type WorkflowState = Schema.Schema.Type<typeof WorkflowState>

export const ActorType = Schema.Literals(["user", "agent"]).annotate({
	identifier: "@maple/ActorType",
	title: "Actor Type",
})
export type ActorType = Schema.Schema.Type<typeof ActorType>

/**
 * Canonical triage severity for issues of every kind. The same literal backs
 * the AI triage agent's `severityAssessment` (see ai-triage.ts) so the two can
 * never drift apart.
 */
export const IssueSeverity = Schema.Literals(["critical", "high", "medium", "low"]).annotate({
	identifier: "@maple/IssueSeverity",
	title: "Issue Severity",
})
export type IssueSeverity = Schema.Schema.Type<typeof IssueSeverity>

/**
 * Who set the issue's current severity. Precedence is manual > ai > detector:
 * AI triage only writes when the source is not "manual", and the detector
 * mapping only applies while severity is still unset.
 */
export const IssueSeveritySource = Schema.Literals(["detector", "ai", "manual"]).annotate({
	identifier: "@maple/IssueSeveritySource",
	title: "Issue Severity Source",
})
export type IssueSeveritySource = Schema.Schema.Type<typeof IssueSeveritySource>

/**
 * What kind of signal backs the issue. "error" issues are fingerprint groups
 * from the errors tick; "alert" issues are created when an alert incident
 * opens (their fingerprintHash is the synthetic `alert:{ruleId}:{groupKey}`);
 * "integration" issues come from third-party webhooks (e.g. PlanetScale
 * branch.out_of_memory — fingerprint `planetscale:{database}:{event}`).
 */
export const IssueKind = Schema.Literals(["error", "alert", "integration"]).annotate({
	identifier: "@maple/IssueKind",
	title: "Issue Kind",
})
export type IssueKind = Schema.Schema.Type<typeof IssueKind>

/** Why an issue owns a fingerprint beyond its own: someone merged it in, or a version bump re-keyed it. */
export const IssueFingerprintSource = Schema.Literals(["merge", "rekey"]).annotate({
	identifier: "@maple/IssueFingerprintSource",
	title: "Issue Fingerprint Source",
})
export type IssueFingerprintSource = Schema.Schema.Type<typeof IssueFingerprintSource>

export const ErrorIssueEventType = Schema.Literals([
	"created",
	"state_change",
	"assignment",
	"claim",
	"release",
	"lease_expired",
	"comment",
	"agent_note",
	"fix_proposed",
	"regression",
	"snooze",
	"unsnooze",
	"ai_triage",
	"anomaly_linked",
	"severity_change",
	"pr_linked",
	"pr_unlinked",
	"pr_merged",
	"verification_started",
	"verification_verdict",
	"merge",
	"unmerge",
]).annotate({
	identifier: "@maple/ErrorIssueEventType",
	title: "Error Issue Event Type",
})
export type ErrorIssueEventType = Schema.Schema.Type<typeof ErrorIssueEventType>

export const ErrorIncidentStatus = Schema.Literals(["open", "resolved"]).annotate({
	identifier: "@maple/ErrorIncidentStatus",
	title: "Error Incident Status",
})
export type ErrorIncidentStatus = Schema.Schema.Type<typeof ErrorIncidentStatus>

export const ErrorIncidentReason = Schema.Literals(["first_seen", "regression", "manual"]).annotate({
	identifier: "@maple/ErrorIncidentReason",
	title: "Error Incident Reason",
})
export type ErrorIncidentReason = Schema.Schema.Type<typeof ErrorIncidentReason>

/** Who escalated an issue, why, and where its delivery stands. */
export const IssueEscalationSource = Schema.Literals(["ai", "manual"])
export const IssueEscalationReason = Schema.Literals(["severity_set", "severity_escalated"])
export const IssueEscalationStatus = Schema.Literals(["queued", "sent", "skipped", "failed"])
