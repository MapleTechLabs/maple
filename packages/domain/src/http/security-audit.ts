import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { AuditReportsRecord, Finding } from "@maple/security-audit/schema"
import { UserId } from "../primitives"
import {
	isSafeScopePath,
	SecurityAuditEventKind,
	SecurityAuditFindingStatus,
	SecurityAuditProfile,
	SecurityAuditRunId,
	SecurityAuditRunKind,
	SecurityAuditRunStatus,
	SecurityAuditSeverity,
	SecurityAuditTargetId,
	SecurityAuditVerdict,
} from "../security-audit"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"

// Request fields

/** The hard cap on one run's agent invocations; a request asking for more is a 400. */
export const SECURITY_AUDIT_MAX_BUDGET = 20_000
const MAX_SCOPE_PATHS = 100

/** `owner/name`, as GitHub spells it. */
export const SecurityAuditRepository = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u),
)

/** A branch name git would accept, without the shapes a ref or an option could hide behind. */
export const SecurityAuditBranch = Schema.String.check(
	Schema.isPattern(/^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/+-]{1,255}$/u),
	Schema.makeFilter((value: string) => !value.endsWith("/") && !value.endsWith(".lock"), {
		description: "a branch name",
	}),
)

const ScopePath = Schema.String.check(
	Schema.isMaxLength(512),
	Schema.makeFilter(isSafeScopePath, { description: "a safe repository-relative path" }),
)
const ScopePaths = Schema.Array(ScopePath).check(Schema.isMaxLength(MAX_SCOPE_PATHS))

const Budget = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SECURITY_AUDIT_MAX_BUDGET }))

const Fingerprint = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))

export const SecurityAuditCreateTargetRequest = Schema.Struct({
	repository: SecurityAuditRepository,
	branch: SecurityAuditBranch,
	profile: Schema.optionalKey(SecurityAuditProfile),
	scopePaths: Schema.optionalKey(ScopePaths),
	budgetPerRun: Schema.optionalKey(Budget),
})
export type SecurityAuditCreateTargetRequest = typeof SecurityAuditCreateTargetRequest.Type

export const SecurityAuditStartRunRequest = Schema.Struct({
	kind: Schema.optionalKey(SecurityAuditRunKind),
	scopePaths: Schema.optionalKey(ScopePaths),
	budget: Schema.optionalKey(Budget),
})
export type SecurityAuditStartRunRequest = typeof SecurityAuditStartRunRequest.Type

/** The statuses a person sets; `fixed` is the engine's to set. */
export const SecurityAuditFindingTriageStatus = Schema.Literals(["open", "dismissed", "accepted_risk"])
export type SecurityAuditFindingTriageStatus = typeof SecurityAuditFindingTriageStatus.Type

export const SecurityAuditUpdateFindingRequest = Schema.Struct({
	status: SecurityAuditFindingTriageStatus,
	reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2000)),
})
export type SecurityAuditUpdateFindingRequest = typeof SecurityAuditUpdateFindingRequest.Type

export const SecurityAuditListRunsQuery = Schema.Struct({
	targetId: Schema.optional(SecurityAuditTargetId),
})

export const SecurityAuditListFindingsQuery = Schema.Struct({
	includeRejected: Schema.optional(Schema.Literals(["true", "false"])),
})

// Responses. Timestamps are epoch milliseconds.

export const SecurityAuditTarget = Schema.Struct({
	id: SecurityAuditTargetId,
	repository: Schema.String,
	branch: Schema.String,
	enabled: Schema.Boolean,
	profile: SecurityAuditProfile,
	scopePaths: Schema.Array(Schema.String),
	budgetPerRun: Schema.NullOr(Schema.Number),
	createdBy: UserId,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
})
export type SecurityAuditTarget = typeof SecurityAuditTarget.Type

const runFields = {
	id: SecurityAuditRunId,
	targetId: SecurityAuditTargetId,
	kind: SecurityAuditRunKind,
	status: SecurityAuditRunStatus,
	sourceRef: Schema.String,
	profile: SecurityAuditProfile,
	scopePaths: Schema.Array(Schema.String),
	budget: Schema.NullOr(Schema.Number),
	invocationsSpent: Schema.Number,
	inputTokens: Schema.Number,
	outputTokens: Schema.Number,
	costUsd: Schema.NullOr(Schema.Number),
	incompleteReason: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	startedAt: Schema.Number,
	finishedAt: Schema.NullOr(Schema.Number),
}

export const SecurityAuditRun = Schema.Struct(runFields)
export type SecurityAuditRun = typeof SecurityAuditRun.Type

/** One run with its reports and how far its coverage ledger got. */
export const SecurityAuditRunDetail = Schema.Struct({
	...runFields,
	reports: Schema.NullOr(AuditReportsRecord),
	architectureMd: Schema.NullOr(Schema.String),
	/** Ledger units per unit status. */
	unitCounts: Schema.Record(Schema.String, Schema.Number),
	unitTotal: Schema.Number,
})
export type SecurityAuditRunDetail = typeof SecurityAuditRunDetail.Type

export const SecurityAuditEvent = Schema.Struct({
	id: Schema.String,
	at: Schema.Number,
	kind: SecurityAuditEventKind,
	role: Schema.NullOr(Schema.String),
	agentId: Schema.NullOr(Schema.String),
	outcome: Schema.NullOr(Schema.String),
	message: Schema.NullOr(Schema.String),
	phase: Schema.NullOr(Schema.String),
	detail: Schema.NullOr(Schema.String),
	costUsd: Schema.NullOr(Schema.Number),
	inputTokens: Schema.NullOr(Schema.Number),
	outputTokens: Schema.NullOr(Schema.Number),
})
export type SecurityAuditEvent = typeof SecurityAuditEvent.Type

export const SecurityAuditFinding = Schema.Struct({
	fingerprint: Schema.String,
	targetId: SecurityAuditTargetId,
	verdict: SecurityAuditVerdict,
	overallSeverity: Schema.NullOr(SecurityAuditSeverity),
	status: SecurityAuditFindingStatus,
	statusReason: Schema.NullOr(Schema.String),
	statusChangedBy: Schema.NullOr(UserId),
	statusChangedAt: Schema.NullOr(Schema.Number),
	record: Finding,
	firstSeenRunId: SecurityAuditRunId,
	lastSeenRunId: SecurityAuditRunId,
	firstSeenRef: Schema.String,
	lastSeenRef: Schema.String,
	fixedRunId: Schema.NullOr(SecurityAuditRunId),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
})
export type SecurityAuditFinding = typeof SecurityAuditFinding.Type

export const SecurityAuditTargetsResponse = Schema.Struct({ targets: Schema.Array(SecurityAuditTarget) })
export const SecurityAuditRunsResponse = Schema.Struct({ runs: Schema.Array(SecurityAuditRun) })
export const SecurityAuditEventsResponse = Schema.Struct({ events: Schema.Array(SecurityAuditEvent) })
export const SecurityAuditFindingsResponse = Schema.Struct({ findings: Schema.Array(SecurityAuditFinding) })

// Errors

/** The org is not in the `securityAudit` rollout. */
export class SecurityAuditDisabledError extends HttpTaggedError<SecurityAuditDisabledError>()(
	"@maple/http/security-audit/SecurityAuditDisabledError",
	{ message: Schema.String },
	{
		status: 403,
		code: "security_audit_disabled",
		title: "Security audits are not enabled",
		retry: "never",
		recovery: "contact_support",
		exposure: "public_message",
	},
) {}

export class SecurityAuditForbiddenError extends HttpTaggedError<SecurityAuditForbiddenError>()(
	"@maple/http/security-audit/SecurityAuditForbiddenError",
	{ message: Schema.String },
	{
		status: 403,
		code: "security_audit_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

export class SecurityAuditTargetNotFoundError extends HttpTaggedError<SecurityAuditTargetNotFoundError>()(
	"@maple/http/security-audit/SecurityAuditTargetNotFoundError",
	{ message: Schema.String, targetId: SecurityAuditTargetId },
	{
		status: 404,
		code: "security_audit_target_not_found",
		title: "Audit target not found",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

export class SecurityAuditRunNotFoundError extends HttpTaggedError<SecurityAuditRunNotFoundError>()(
	"@maple/http/security-audit/SecurityAuditRunNotFoundError",
	{ message: Schema.String, runId: SecurityAuditRunId },
	{
		status: 404,
		code: "security_audit_run_not_found",
		title: "Audit run not found",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

export class SecurityAuditFindingNotFoundError extends HttpTaggedError<SecurityAuditFindingNotFoundError>()(
	"@maple/http/security-audit/SecurityAuditFindingNotFoundError",
	{ message: Schema.String, targetId: SecurityAuditTargetId, fingerprint: Schema.String },
	{
		status: 404,
		code: "security_audit_finding_not_found",
		title: "Finding not found",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

/** The run row was written but its Workflow did not start; the run is marked failed. */
export class SecurityAuditStartError extends HttpTaggedError<SecurityAuditStartError>()(
	"@maple/http/security-audit/SecurityAuditStartError",
	{ message: Schema.String, runId: SecurityAuditRunId, cause: Schema.optionalKey(Schema.String) },
	{
		status: 503,
		code: "security_audit_start_failed",
		title: "The audit could not start",
		message: "The audit could not start. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class SecurityAuditPersistenceError extends HttpTaggedError<SecurityAuditPersistenceError>()(
	"@maple/http/security-audit/SecurityAuditPersistenceError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
	{
		status: 503,
		code: "security_audit_unavailable",
		title: "Security audits are temporarily unavailable",
		message: "Security audits are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

const readErrors = [SecurityAuditDisabledError, SecurityAuditPersistenceError] as const
const writeErrors = [...readErrors, SecurityAuditForbiddenError] as const

// API group

/** The scheduled security audit, served by the ai Worker. Dashboard only, behind `securityAudit`. */
export class SecurityAuditApiGroup extends HttpApiGroup.make("securityAudit")
	.add(
		HttpApiEndpoint.post("createTarget", "/targets", {
			payload: SecurityAuditCreateTargetRequest,
			success: SecurityAuditTarget,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.get("listTargets", "/targets", {
			success: SecurityAuditTargetsResponse,
			error: readErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("startRun", "/targets/:targetId/runs", {
			params: { targetId: SecurityAuditTargetId },
			payload: SecurityAuditStartRunRequest,
			success: SecurityAuditRun,
			error: [...writeErrors, SecurityAuditTargetNotFoundError, SecurityAuditStartError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listRuns", "/runs", {
			query: SecurityAuditListRunsQuery,
			success: SecurityAuditRunsResponse,
			error: readErrors,
		}),
	)
	.add(
		HttpApiEndpoint.get("getRun", "/runs/:runId", {
			params: { runId: SecurityAuditRunId },
			success: SecurityAuditRunDetail,
			error: [...readErrors, SecurityAuditRunNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listRunEvents", "/runs/:runId/events", {
			params: { runId: SecurityAuditRunId },
			success: SecurityAuditEventsResponse,
			error: [...readErrors, SecurityAuditRunNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listFindings", "/targets/:targetId/findings", {
			params: { targetId: SecurityAuditTargetId },
			query: SecurityAuditListFindingsQuery,
			success: SecurityAuditFindingsResponse,
			error: [...readErrors, SecurityAuditTargetNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.patch("updateFindingStatus", "/targets/:targetId/findings/:fingerprint", {
			params: { targetId: SecurityAuditTargetId, fingerprint: Fingerprint },
			payload: SecurityAuditUpdateFindingRequest,
			success: SecurityAuditFinding,
			error: [...writeErrors, SecurityAuditFindingNotFoundError],
		}),
	)
	.prefix("/api/security-audit")
	.middleware(SessionAuthorization) {}
