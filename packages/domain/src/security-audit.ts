/**
 * Identifiers and states of the scheduled security audit: a target (one repository branch the org
 * audits), its runs, and the findings followed across runs.
 */
import { Schema } from "effect"

export const SecurityAuditTargetId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/SecurityAuditTargetId"),
	Schema.annotate({ identifier: "@maple/SecurityAuditTargetId", title: "Security Audit Target ID" }),
)
export type SecurityAuditTargetId = Schema.Schema.Type<typeof SecurityAuditTargetId>

/** The engine's `run_id`; the host mints it, so it is any non-empty string. */
export const SecurityAuditRunId = Schema.String.check(Schema.isNonEmpty()).pipe(
	Schema.brand("@maple/SecurityAuditRunId"),
	Schema.annotate({ identifier: "@maple/SecurityAuditRunId", title: "Security Audit Run ID" }),
)
export type SecurityAuditRunId = Schema.Schema.Type<typeof SecurityAuditRunId>

export const SecurityAuditProfile = Schema.Literals(["quick", "standard", "deep"])
export type SecurityAuditProfile = typeof SecurityAuditProfile.Type

export const SecurityAuditRunKind = Schema.Literals(["baseline", "slice", "revalidation", "manual"])
export type SecurityAuditRunKind = typeof SecurityAuditRunKind.Type

export const SecurityAuditRunStatus = Schema.Literals(["in_progress", "complete", "incomplete", "failed"])
export type SecurityAuditRunStatus = typeof SecurityAuditRunStatus.Type

export const SecurityAuditVerdict = Schema.Literals(["confirmed", "needs_validation", "rejected"])
export type SecurityAuditVerdict = typeof SecurityAuditVerdict.Type

export const SecurityAuditSeverity = Schema.Literals(["informational", "low", "medium", "high", "critical"])
export type SecurityAuditSeverity = typeof SecurityAuditSeverity.Type

/** A finding's lifecycle on its target; only `fixed` reopens when the fingerprint comes back. */
export const SecurityAuditFindingStatus = Schema.Literals(["open", "fixed", "dismissed", "accepted_risk"])
export type SecurityAuditFindingStatus = typeof SecurityAuditFindingStatus.Type

export const SecurityAuditEventKind = Schema.Literals(["Agent", "Phase", "Note"])
export type SecurityAuditEventKind = typeof SecurityAuditEventKind.Type

/** What starts one audit run in the ai Worker's Workflow. The run row exists before it starts. */
export const SecurityAuditWorkflowPayload = Schema.Struct({
	orgId: Schema.String,
	runId: Schema.String,
	repository: Schema.String,
	/** Branch or commit; the run pins the commit it resolves to before any agent starts. */
	ref: Schema.String,
	profile: SecurityAuditProfile,
	scopePaths: Schema.Array(Schema.String),
	budget: Schema.NullOr(Schema.Int),
	priorRunId: Schema.NullOr(Schema.String),
})
export type SecurityAuditWorkflowPayload = typeof SecurityAuditWorkflowPayload.Type
