import { Schema, Array as Arr } from "effect"
import { InvestigationId, IsoDateTimeString, UserId } from "../primitives"
import { AiTriageResult } from "./ai-triage"
import { HttpTaggedError } from "./error-policy"
import { IssueSeverity } from "./errors"

import {
	InvestigationConfidence,
	InvestigationProgress,
	InvestigationSeededBy,
	InvestigationStatus,
	InvestigationSubject,
	InvestigationSubjectSnapshot,
} from "../investigations"
export {
	InvestigationConfidence,
	InvestigationContextRef,
	InvestigationFixVerificationSubject,
	InvestigationFreeformSubject,
	InvestigationIncidentSubject,
	InvestigationProgress,
	InvestigationSeededBy,
	InvestigationSnapshotFact,
	InvestigationSnapshotReference,
	InvestigationStatus,
	InvestigationStep,
	InvestigationSubject,
	InvestigationSubjectSnapshot,
} from "../investigations"

/**
 * The status moves a person may make by hand: resolve a finished run, or reopen a resolved one.
 * The autonomous pass owns everything else (`investigating` and the verdict it lands on); starting
 * a new pass is a restart, not a status change.
 */
export const MANUAL_INVESTIGATION_TRANSITIONS = {
	investigating: [],
	diagnosed: ["resolved"],
	inconclusive: ["resolved"],
	failed: ["resolved"],
	resolved: ["diagnosed", "inconclusive", "failed"],
} as const satisfies Record<InvestigationStatus, ReadonlyArray<InvestigationStatus>>

/**
 * Where reopening a resolved investigation lands: back on the verdict its run reached, so a
 * reopen cannot claim a diagnosis that never happened. `failed` is the latest run's own outcome
 * (a failure records an error, a restart or a report clears it), so a rerun that failed after an
 * earlier diagnosis reopens as `failed`, not on the stale report.
 */
export const reopenedInvestigationStatus = (run: {
	readonly failed: boolean
	readonly diagnosed: boolean
	readonly hasReport: boolean
}): InvestigationStatus =>
	run.failed ? "failed" : run.diagnosed ? "diagnosed" : run.hasReport ? "inconclusive" : "failed"

/** A run in flight cannot be restarted underneath itself; every settled one can. */
export const RESTARTABLE_INVESTIGATION_STATUSES = [
	"diagnosed",
	"inconclusive",
	"failed",
	"resolved",
] as const satisfies Arr.NonEmptyReadonlyArray<InvestigationStatus>

/** How many steps a progress record keeps. */
export const INVESTIGATION_PROGRESS_STEPS = 12

/**
 * Just the `type` discriminator of a subject.
 *
 * Derived from the union's own members rather than restated, so a fourth
 * subject type cannot leave this list behind — the drift would be silent, and
 * the one consumer that matters (`subjectTypeOf`, which decides whether a run
 * may re-rank an issue's severity) fails open when it cannot read the type.
 *
 * Deliberately NOT the full subject: reading the discriminator must stay
 * possible for a row whose other fields have drifted or were written by an
 * older shape. A full decode would answer "unknown" for a subject that is
 * plainly a verification, which is the dangerous direction.
 */
export const InvestigationSubjectType = Schema.Literals(
	Arr.map(InvestigationSubject.members, (member) => member.fields.type.literal),
).annotate({ identifier: "@maple/InvestigationSubjectType", title: "Investigation Subject Type" })
export type InvestigationSubjectType = Schema.Schema.Type<typeof InvestigationSubjectType>

/** A stored subject, read for its discriminator alone. See {@link InvestigationSubjectType}. */
export const InvestigationSubjectDiscriminator = Schema.Struct({
	type: InvestigationSubjectType,
}).annotate({ identifier: "@maple/InvestigationSubjectDiscriminator" })

export class InvestigationDocument extends Schema.Class<InvestigationDocument>("InvestigationDocument")({
	id: InvestigationId,
	status: InvestigationStatus,
	subject: InvestigationSubject,
	snapshot: InvestigationSubjectSnapshot,
	/** The latest structured diagnosis, or null until the first `submit_diagnosis`. */
	report: Schema.NullOr(AiTriageResult),
	/** What the pass is doing, or got as far as doing. Null before the first step; kept after the run ends. */
	progress: Schema.NullOr(InvestigationProgress),
	model: Schema.NullOr(Schema.String),
	/** Denormalized from the report for cheap war-room list rendering. */
	severity: Schema.NullOr(IssueSeverity),
	confidence: Schema.NullOr(InvestigationConfidence),
	seededBy: InvestigationSeededBy,
	createdBy: Schema.NullOr(UserId),
	inputTokens: Schema.NullOr(Schema.Number),
	outputTokens: Schema.NullOr(Schema.Number),
	error: Schema.NullOr(Schema.String),
	createdAt: IsoDateTimeString,
	/**
	 * When the current pass began. Re-stamped on every restart, which is what makes
	 * it — and not `createdAt` — the right start for "how long did this run take".
	 */
	startedAt: Schema.NullOr(IsoDateTimeString),
	diagnosedAt: Schema.NullOr(IsoDateTimeString),
	updatedAt: IsoDateTimeString,
}) {}

export class InvestigationsListResponse extends Schema.Class<InvestigationsListResponse>(
	"InvestigationsListResponse",
)({
	investigations: Schema.Array(InvestigationDocument),
}) {}

export class InvestigationCreateRequest extends Schema.Class<InvestigationCreateRequest>(
	"InvestigationCreateRequest",
)({
	subject: InvestigationSubject,
	snapshot: Schema.optionalKey(InvestigationSubjectSnapshot),
}) {}

/**
 * The internal write the `submit_diagnosis` tool posts once the
 * agent finishes its diagnostic pass. Carries the structured report plus the
 * model + token usage for billing/observability. Re-uses `AiTriageResult` and
 * `AiTriageEvidence` verbatim — the report shape is unchanged.
 */
export class SubmitDiagnosisRequest extends Schema.Class<SubmitDiagnosisRequest>("SubmitDiagnosisRequest")({
	report: AiTriageResult,
	model: Schema.optionalKey(Schema.String),
	inputTokens: Schema.optionalKey(Schema.Number),
	outputTokens: Schema.optionalKey(Schema.Number),
	/**
	 * The report is a partial: filed by the close-out turn after the pass itself ended
	 * without one. It lands as `inconclusive`, never as a diagnosis.
	 */
	partial: Schema.optionalKey(Schema.Boolean),
	/**
	 * The chat turn that filed it. A later turn's diagnosis supersedes this one and gets its own
	 * timeline events; a retry within the same turn collapses into the first.
	 */
	turnId: Schema.optionalKey(Schema.String),
}) {}

export class InvestigationPersistenceError extends HttpTaggedError<InvestigationPersistenceError>()(
	"@maple/http/investigations/InvestigationPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{
		status: 503,
		code: "investigations_unavailable",
		title: "Investigations are temporarily unavailable",
		message: "Investigations are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class InvestigationValidationError extends HttpTaggedError<InvestigationValidationError>()(
	"@maple/http/investigations/InvestigationValidationError",
	{
		message: Schema.String,
	},
	{
		status: 400,
		code: "investigation_invalid",
		title: "Invalid investigation",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

export class InvestigationNotFoundError extends HttpTaggedError<InvestigationNotFoundError>()(
	"@maple/http/investigations/InvestigationNotFoundError",
	{
		message: Schema.String,
	},
	{
		status: 404,
		code: "investigation_not_found",
		title: "Investigation not found",
		message: "No such investigation.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class InvestigationQuotaError extends HttpTaggedError<InvestigationQuotaError>()(
	"@maple/http/investigations/InvestigationQuotaError",
	{
		message: Schema.String,
		/**
		 * Which of the two daily ceilings was hit. Carried because a run and a model
		 * pass are different units with different settings, and an operator told only
		 * "quota reached" cannot tell which number to raise.
		 */
		dimension: Schema.Literals(["runs", "passes"]),
		limit: Schema.Number,
		retryableAt: IsoDateTimeString,
	},
	{
		status: 429,
		code: "investigation_daily_quota",
		title: "Investigation limit reached",
		message: (error) =>
			error.dimension === "runs"
				? `Daily limit of ${error.limit} investigations reached. Resets at ${error.retryableAt}.`
				: `Daily limit of ${error.limit} model passes reached. Resets at ${error.retryableAt}.`,
		retry: "after",
		retryAt: (error) => error.retryableAt,
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** Automatic starts are disabled by organization policy. Retrying unchanged cannot help. */
export class InvestigationAutomationDisabledError extends HttpTaggedError<InvestigationAutomationDisabledError>()(
	"@maple/http/investigations/InvestigationAutomationDisabledError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "investigation_automation_disabled",
		title: "Automatic investigations are disabled",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

/** The investigation agent/workflow binding cannot currently be reached. */
export class InvestigationAgentUnavailableError extends HttpTaggedError<InvestigationAgentUnavailableError>()(
	"@maple/http/investigations/InvestigationAgentUnavailableError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "investigation_agent_unavailable",
		title: "Investigation agent is temporarily unavailable",
		retry: "backoff",
		recovery: "retry",
		exposure: "public_message",
	},
) {}

/** A configured agent was reached, but the investigation turn could not be started. */
export class InvestigationStartFailedError extends HttpTaggedError<InvestigationStartFailedError>()(
	"@maple/http/investigations/InvestigationStartFailedError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{
		status: 503,
		code: "investigation_start_failed",
		title: "Investigation could not be started",
		retry: "backoff",
		recovery: "retry",
		message: "The investigation could not be started. Retry in a few seconds.",
		exposure: "redacted",
	},
) {}

export class InvestigationRejectedError extends HttpTaggedError<InvestigationRejectedError>()(
	"@maple/http/investigations/InvestigationRejectedError",
	{
		message: Schema.String,
		status: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 400, maximum: 499 })),
	},
	{
		status: 502,
		code: "investigation_start_rejected",
		title: "Investigation agent rejected the request",
		message: (error) => `The investigation agent rejected the start request with HTTP ${error.status}.`,
		retry: "never",
		recovery: "reconnect",
		exposure: "redacted",
	},
) {}

/** The status change is not one the investigation's state allows, or another writer moved it first. */
export class InvestigationTransitionError extends HttpTaggedError<InvestigationTransitionError>()(
	"@maple/http/investigations/InvestigationTransitionError",
	{
		message: Schema.String,
		investigationId: InvestigationId,
		fromStatus: InvestigationStatus,
		toStatus: InvestigationStatus,
	},
	{
		status: 409,
		code: "investigation_status_conflict",
		title: "Investigation status cannot change",
		retry: "never",
		recovery: "refresh",
		exposure: "public_message",
	},
) {}

/** Stored investigation data no longer decodes into its current public schema. */
export class InvestigationDataCorruptionError extends HttpTaggedError<InvestigationDataCorruptionError>()(
	"@maple/http/investigations/InvestigationDataCorruptionError",
	{
		message: Schema.String,
		investigationId: InvestigationId,
		field: Schema.String,
		value: Schema.String,
		incidentKind: Schema.optionalKey(Schema.String),
		incidentId: Schema.optionalKey(Schema.String),
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{
		status: 500,
		code: "investigation_data_corrupt",
		title: "Stored investigation data is invalid",
		message: "Maple could not decode the stored investigation.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}
