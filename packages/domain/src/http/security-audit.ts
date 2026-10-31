import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { ExecutionProfile } from "@maple/security-audit/ecosystems"
import { AuditReportsRecord, Finding, UnitStatus } from "@maple/security-audit/schema"
import { IsoDateTimeString, UserId } from "../primitives"
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
	SecurityAuditDiscoveryModel,
	SecurityAuditValidationModel,
} from "../security-audit"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"

// Request fields

/** The highest monthly spend limit an org may set, in whole US dollars. */
export const SECURITY_AUDIT_MAX_MONTHLY_SPEND_USD = 100_000
/** Events per page, and the most one page may ask for. */
export const SECURITY_AUDIT_EVENTS_DEFAULT_LIMIT = 200
const SECURITY_AUDIT_EVENTS_MAX_LIMIT = 1000
const MAX_SCOPE_PATHS = 100

/** `owner/name`, as GitHub spells it. */
export const SecurityAuditRepository = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u, {
		message: "Expected a GitHub repository as owner/name, like acme/api",
	}),
)

/** A branch name git would accept, without the shapes a ref or an option could hide behind. */
export const SecurityAuditBranch = Schema.String.check(
	Schema.isPattern(/^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/+-]{1,255}$/u, {
		message:
			"Expected a branch name of letters, digits and . _ / + -, not starting with - / or . and without '..', '//' or '@{'",
	}),
	Schema.makeFilter((value: string) => !value.endsWith("/") && !value.endsWith(".lock"), {
		description: "a branch name",
		message: "Expected a branch name that does not end in '/' or '.lock'",
	}),
)

const ScopePath = Schema.String.check(
	Schema.isMaxLength(512),
	Schema.makeFilter(isSafeScopePath, {
		description: "a safe repository-relative path",
		message:
			"Expected a repository-relative path like src/api: no '..', '~', ':', backslashes, leading '/', empty segments or surrounding spaces",
	}),
)
const ScopePaths = Schema.Array(ScopePath).check(Schema.isMaxLength(MAX_SCOPE_PATHS))

const Fingerprint = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1024))

export const SecurityAuditCreateTargetRequest = Schema.Struct({
	repository: SecurityAuditRepository,
	branch: SecurityAuditBranch,
	profile: Schema.optionalKey(SecurityAuditProfile),
	scopePaths: Schema.optionalKey(ScopePaths),
	/** Overrides the org's models for this target; absent runs on the org's pick. */
	discoveryModel: Schema.optionalKey(SecurityAuditDiscoveryModel),
	validationModel: Schema.optionalKey(SecurityAuditValidationModel),
})
export type SecurityAuditCreateTargetRequest = typeof SecurityAuditCreateTargetRequest.Type

/** Runs started here are always `manual`; the scheduler picks the other kinds. */
export const SecurityAuditStartRunRequest = Schema.Struct({
	scopePaths: Schema.optionalKey(ScopePaths),
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

export const SecurityAuditUpdateSettingsRequest = Schema.Struct({
	monthlySpendLimitUsd: Schema.Int.check(
		Schema.isBetween({ minimum: 1, maximum: SECURITY_AUDIT_MAX_MONTHLY_SPEND_USD }),
	),
	discoveryModel: SecurityAuditDiscoveryModel,
	validationModel: SecurityAuditValidationModel,
})
export type SecurityAuditUpdateSettingsRequest = typeof SecurityAuditUpdateSettingsRequest.Type

export const SecurityAuditListRunsQuery = Schema.Struct({
	targetId: Schema.optional(SecurityAuditTargetId),
})

export const SecurityAuditListEventsQuery = Schema.Struct({
	limit: Schema.optional(
		Schema.NumberFromString.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: SECURITY_AUDIT_EVENTS_MAX_LIMIT }),
		),
	),
	/** Epoch ms: only events strictly before it; the page's oldest `at` fetches the next page. */
	beforeAt: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))),
	/** The last event id of the previous page, so events in the same millisecond are not skipped. */
	beforeId: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
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
	/** The target's own models; null runs on the org's. */
	discoveryModel: Schema.NullOr(Schema.String),
	validationModel: Schema.NullOr(Schema.String),
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
	/** What the run's models cost, in AI credits (US dollars); null until the run settles. */
	costUsd: Schema.NullOr(Schema.Number),
	/** The sandbox fee its agents were charged, in AI credits (US dollars), as they launched. */
	sandboxUsd: Schema.Number,
	/** The OpenRouter model ids the run used; null for runs from before they were recorded. */
	discoveryModel: Schema.NullOr(Schema.String),
	validationModel: Schema.NullOr(Schema.String),
	incompleteReason: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	startedAt: Schema.Number,
	finishedAt: Schema.NullOr(Schema.Number),
}

export const SecurityAuditRun = Schema.Struct(runFields)

/** The org's monthly spend limit and what it has spent this UTC month, with its default models. */
export const SecurityAuditSettings = Schema.Struct({
	/** Whole US dollars per UTC month. */
	monthlySpendLimitUsd: Schema.Number,
	/** What the org's agents cost since `since`, models and sandbox, in AI credits (US dollars). */
	spentUsd: Schema.Number,
	/** Epoch ms: the start of the UTC month. */
	since: Schema.Number,
	/** Epoch ms: when the spend starts over. */
	resetsAt: Schema.Number,
	/** OpenRouter model ids a target without its own runs on. */
	discoveryModel: Schema.String,
	validationModel: Schema.String,
})
export type SecurityAuditSettings = typeof SecurityAuditSettings.Type
export type SecurityAuditRun = typeof SecurityAuditRun.Type

/** One run with its reports and how far its coverage ledger got. */
export const SecurityAuditRunDetail = Schema.Struct({
	...runFields,
	reports: Schema.NullOr(AuditReportsRecord),
	architectureMd: Schema.NullOr(Schema.String),
	/** How the run may execute target code and why not; null until prepare inspects the repository. */
	executionProfile: Schema.NullOr(ExecutionProfile),
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

/** A triage write's result: what changed, independent of the stored record's shape. */
export const SecurityAuditFindingTriageResult = Schema.Struct({
	targetId: SecurityAuditTargetId,
	fingerprint: Schema.String,
	status: SecurityAuditFindingTriageStatus,
	statusReason: Schema.String,
	statusChangedAt: Schema.Number,
})
export type SecurityAuditFindingTriageResult = typeof SecurityAuditFindingTriageResult.Type

export const SecurityAuditFinding = Schema.Struct({
	fingerprint: Schema.String,
	targetId: SecurityAuditTargetId,
	verdict: SecurityAuditVerdict,
	overallSeverity: Schema.NullOr(SecurityAuditSeverity),
	/**
	 * A needs-validation lead's severity as the engine estimates it from the code it read, before
	 * anything proves it; null for confirmed and rejected findings and for a lead given no estimate.
	 */
	estimatedSeverity: Schema.NullOr(SecurityAuditSeverity),
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

/**
 * One coverage-ledger unit, lean: no prompts, paths or attempt history. The human fields are null
 * (and `stale` true) when the stored unit predates the current schema.
 */
export const SecurityAuditUnit = Schema.Struct({
	coverageId: Schema.String,
	status: UnitStatus,
	wave: Schema.Number,
	agentId: Schema.NullOr(Schema.String),
	stale: Schema.Boolean,
	subsystem: Schema.NullOr(Schema.String),
	surface: Schema.NullOr(Schema.String),
	boundary: Schema.NullOr(Schema.String),
	attackClass: Schema.NullOr(Schema.String),
	priorStatus: Schema.NullOr(Schema.String),
	priority: Schema.NullOr(Schema.Number),
	failedAttempts: Schema.NullOr(Schema.Number),
	/** Fingerprints of the candidates or findings this unit produced, the first 20. */
	resultFingerprints: Schema.Array(Schema.String),
	/** The prior run's finding this unit re-checks, if any. */
	carriedFingerprint: Schema.NullOr(Schema.String),
	/** Why the unit is not done (blocked, deferred), each entry trimmed. */
	unresolved: Schema.Array(Schema.String),
})
export type SecurityAuditUnit = typeof SecurityAuditUnit.Type

export const SecurityAuditTargetsResponse = Schema.Struct({ targets: Schema.Array(SecurityAuditTarget) })
/**
 * What one run reported, per severity: confirmed findings by their severity and needs-validation
 * leads by their estimate. `unverified` is how many of those severity counts are estimates;
 * `needsValidation` is the leads with no estimate.
 */
export const SecurityAuditRunFindingCounts = Schema.Struct({
	critical: Schema.Number,
	high: Schema.Number,
	medium: Schema.Number,
	low: Schema.Number,
	informational: Schema.Number,
	unverified: Schema.Number,
	needsValidation: Schema.Number,
	rejected: Schema.Number,
})
export type SecurityAuditRunFindingCounts = typeof SecurityAuditRunFindingCounts.Type

export const SecurityAuditRunsResponse = Schema.Struct({
	runs: Schema.Array(SecurityAuditRun),
	/** Per run id; admins only, since members may list runs but not read findings. */
	findingCounts: Schema.optionalKey(Schema.Record(Schema.String, SecurityAuditRunFindingCounts)),
})
export const SecurityAuditEventsResponse = Schema.Struct({ events: Schema.Array(SecurityAuditEvent) })
export const SecurityAuditFindingsResponse = Schema.Struct({ findings: Schema.Array(SecurityAuditFinding) })
export const SecurityAuditUnitsResponse = Schema.Struct({ units: Schema.Array(SecurityAuditUnit) })

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

/** The target already has a run in progress; one runs at a time per target. */
export class SecurityAuditRunInProgressError extends HttpTaggedError<SecurityAuditRunInProgressError>()(
	"@maple/http/security-audit/SecurityAuditRunInProgressError",
	{ message: Schema.String, targetId: SecurityAuditTargetId },
	{
		status: 409,
		code: "security_audit_run_in_progress",
		title: "An audit is already running",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

/** The run already finished (complete, incomplete or failed), so there is nothing to cancel. */
export class SecurityAuditRunNotInProgressError extends HttpTaggedError<SecurityAuditRunNotInProgressError>()(
	"@maple/http/security-audit/SecurityAuditRunNotInProgressError",
	{ message: Schema.String, runId: SecurityAuditRunId },
	{
		status: 409,
		code: "security_audit_run_not_in_progress",
		title: "The audit is not running",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

export class SecurityAuditTargetDisabledError extends HttpTaggedError<SecurityAuditTargetDisabledError>()(
	"@maple/http/security-audit/SecurityAuditTargetDisabledError",
	{ message: Schema.String, targetId: SecurityAuditTargetId },
	{
		status: 409,
		code: "security_audit_target_disabled",
		title: "Audit target is disabled",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

export class SecurityAuditTargetExistsError extends HttpTaggedError<SecurityAuditTargetExistsError>()(
	"@maple/http/security-audit/SecurityAuditTargetExistsError",
	{ message: Schema.String },
	{
		status: 409,
		code: "security_audit_target_exists",
		title: "Audit target already exists",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

/** The repository is over a size limit, by what GitHub reports, before anything is cloned. */
export class SecurityAuditRepositoryTooLargeError extends HttpTaggedError<SecurityAuditRepositoryTooLargeError>()(
	"@maple/http/security-audit/SecurityAuditRepositoryTooLargeError",
	{ message: Schema.String, repository: Schema.String },
	{
		status: 422,
		code: "security_audit_repository_too_large",
		title: "Repository too large to audit",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

/** Audits are paid in AI credits, and the org's plan includes none. */
export class SecurityAuditNotInPlanError extends HttpTaggedError<SecurityAuditNotInPlanError>()(
	"@maple/http/security-audit/SecurityAuditNotInPlanError",
	{ message: Schema.String },
	{
		status: 402,
		code: "security_audit_not_in_plan",
		title: "Security audits need AI credits",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

/** The org has spent its AI credits for this billing period and its plan allows no overage. */
export class SecurityAuditCreditsUsedUpError extends HttpTaggedError<SecurityAuditCreditsUsedUpError>()(
	"@maple/http/security-audit/SecurityAuditCreditsUsedUpError",
	{
		message: Schema.String,
		/** When the org's AI credits reset to their grant. */
		resetsAt: IsoDateTimeString,
	},
	{
		status: 402,
		code: "security_audit_credits_used_up",
		title: "AI credits used up",
		retry: "after",
		retryAt: (error) => error.resetsAt,
		recovery: "retry",
		exposure: "public_message",
	},
) {}

/** The org has no connected repository by that name. */
export class SecurityAuditRepositoryNotConnectedError extends HttpTaggedError<SecurityAuditRepositoryNotConnectedError>()(
	"@maple/http/security-audit/SecurityAuditRepositoryNotConnectedError",
	{ message: Schema.String, repository: Schema.String },
	{
		status: 404,
		code: "security_audit_repository_not_connected",
		title: "Repository not connected",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** Verification would run on the hunter's model, which would share the hunter's blind spots. */
export class SecurityAuditSameModelsError extends HttpTaggedError<SecurityAuditSameModelsError>()(
	"@maple/http/security-audit/SecurityAuditSameModelsError",
	{ message: Schema.String, model: Schema.String },
	{
		status: 400,
		code: "security_audit_same_models",
		title: "Pick a different verification model",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** The org has spent its monthly limit; runs start again when it resets or an admin raises it. */
export class SecurityAuditSpendLimitReachedError extends HttpTaggedError<SecurityAuditSpendLimitReachedError>()(
	"@maple/http/security-audit/SecurityAuditSpendLimitReachedError",
	{
		message: Schema.String,
		limitUsd: Schema.Number,
		spentUsd: Schema.Number,
		/** When the spend starts over: the first of next month, UTC. */
		resetsAt: IsoDateTimeString,
	},
	{
		status: 402,
		code: "security_audit_spend_limit_reached",
		title: "Monthly spend limit reached",
		retry: "after",
		retryAt: (error) => error.resetsAt,
		recovery: "retry",
		exposure: "public_message",
	},
) {}

const readErrors = [SecurityAuditDisabledError, SecurityAuditPersistenceError] as const
/** Writes, and the reads that expose findings or reports: org admins only. */
const adminErrors = [...readErrors, SecurityAuditForbiddenError] as const

// API group

/** The scheduled security audit, served by the ai Worker. Dashboard only, behind `securityAudit`. */
export class SecurityAuditApiGroup extends HttpApiGroup.make("securityAudit")
	.add(
		HttpApiEndpoint.post("createTarget", "/targets", {
			payload: SecurityAuditCreateTargetRequest,
			success: SecurityAuditTarget,
			error: [
				...adminErrors,
				SecurityAuditRepositoryNotConnectedError,
				SecurityAuditTargetExistsError,
				SecurityAuditRepositoryTooLargeError,
				SecurityAuditSameModelsError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("getSettings", "/settings", {
			success: SecurityAuditSettings,
			error: readErrors,
		}),
	)
	.add(
		HttpApiEndpoint.put("updateSettings", "/settings", {
			payload: SecurityAuditUpdateSettingsRequest,
			success: SecurityAuditSettings,
			error: [...adminErrors, SecurityAuditSameModelsError],
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
			error: [
				...adminErrors,
				SecurityAuditTargetNotFoundError,
				SecurityAuditTargetDisabledError,
				SecurityAuditRunInProgressError,
				SecurityAuditNotInPlanError,
				SecurityAuditCreditsUsedUpError,
				SecurityAuditSpendLimitReachedError,
				SecurityAuditRepositoryTooLargeError,
				SecurityAuditStartError,
			],
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
			error: [...adminErrors, SecurityAuditRunNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.post("cancelRun", "/runs/:runId/cancel", {
			params: { runId: SecurityAuditRunId },
			success: SecurityAuditRun,
			error: [...adminErrors, SecurityAuditRunNotFoundError, SecurityAuditRunNotInProgressError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listRunUnits", "/runs/:runId/units", {
			params: { runId: SecurityAuditRunId },
			success: SecurityAuditUnitsResponse,
			error: [...adminErrors, SecurityAuditRunNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listRunEvents", "/runs/:runId/events", {
			params: { runId: SecurityAuditRunId },
			query: SecurityAuditListEventsQuery,
			success: SecurityAuditEventsResponse,
			error: [...adminErrors, SecurityAuditRunNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listRunFindings", "/runs/:runId/findings", {
			params: { runId: SecurityAuditRunId },
			success: SecurityAuditFindingsResponse,
			error: [...adminErrors, SecurityAuditRunNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listFindings", "/targets/:targetId/findings", {
			params: { targetId: SecurityAuditTargetId },
			query: SecurityAuditListFindingsQuery,
			success: SecurityAuditFindingsResponse,
			error: [...adminErrors, SecurityAuditTargetNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.patch("updateFindingStatus", "/targets/:targetId/findings/:fingerprint", {
			params: { targetId: SecurityAuditTargetId, fingerprint: Fingerprint },
			payload: SecurityAuditUpdateFindingRequest,
			success: SecurityAuditFindingTriageResult,
			error: [...adminErrors, SecurityAuditFindingNotFoundError],
		}),
	)
	.prefix("/api/security-audit")
	.middleware(SessionAuthorization) {}
