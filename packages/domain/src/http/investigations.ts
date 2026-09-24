import { Schema } from "effect"
import {
	ErrorIssueId,
	ErrorIssueVerificationId,
	InvestigationId,
	IsoDateTimeString,
	UserId,
} from "../primitives"
import { AiTriageIncidentKind, AiTriageResult } from "./ai-triage"
import { HttpTaggedError } from "./error-policy"
import { IssueSeverity } from "./errors"

// Literals

/**
 * Lifecycle of a durable investigation "war-room". `investigating` covers the
 * autonomous diagnostic pass (the agent's first turn); `diagnosed` is set once
 * `submit_diagnosis` lands a report; `resolved` is a human-closed terminal.
 *
 * `inconclusive` and `failed` are both terminal and are not the same claim.
 * `failed` means the machinery broke — the agent died, or ended its pass with
 * no report. `inconclusive` means the machinery worked and the answer is "not
 * established": the run published a partial saying what it ruled out and what
 * it could not check. Collapsing the two is what made every honest "we could
 * not tell" render as a defect, with the raw error string shown to the user.
 */
export const InvestigationStatus = Schema.Literals([
	"investigating",
	"diagnosed",
	"inconclusive",
	"resolved",
	"failed",
]).annotate({
	identifier: "@maple/InvestigationStatus",
	title: "Investigation Status",
})
export type InvestigationStatus = Schema.Schema.Type<typeof InvestigationStatus>

/** Who opened the investigation: a person (attended) or an incident-open trigger. */
export const InvestigationSeededBy = Schema.Literals(["user", "system"]).annotate({
	identifier: "@maple/InvestigationSeededBy",
	title: "Investigation Seeded By",
})
export type InvestigationSeededBy = Schema.Schema.Type<typeof InvestigationSeededBy>

export const InvestigationConfidence = Schema.Literals(["high", "medium", "low"]).annotate({
	identifier: "@maple/InvestigationConfidence",
	title: "Investigation Confidence",
})
export type InvestigationConfidence = Schema.Schema.Type<typeof InvestigationConfidence>

// Run progress

/** One thing the pass did. `tool` stays beside the display `label` because it is the only part worth matching on later. */
export const InvestigationStep = Schema.Struct({
	tool: Schema.String,
	label: Schema.String,
	at: Schema.Number,
}).annotate({ identifier: "@maple/InvestigationStep", title: "Investigation Step" })
export type InvestigationStep = Schema.Schema.Type<typeof InvestigationStep>

/** How many steps a progress record keeps. */
export const INVESTIGATION_PROGRESS_STEPS = 12

/**
 * What a running pass is doing, durably. `steps` is a tail capped at
 * {@link INVESTIGATION_PROGRESS_STEPS} (the transcript is the full record, and the table
 * replicates with REPLICA IDENTITY FULL), so `stepCount` is stored rather than derived.
 */
export const InvestigationProgress = Schema.Struct({
	stepCount: Schema.Number,
	steps: Schema.Array(InvestigationStep),
	updatedAt: Schema.Number,
}).annotate({ identifier: "@maple/InvestigationProgress", title: "Investigation Progress" })
export type InvestigationProgress = Schema.Schema.Type<typeof InvestigationProgress>

// Subject (what is being investigated)

/**
 * A page/entity context hint carried by a free-form investigation — structurally
 * the web's `AutoContext` (service / trace / dashboard / error_issue / …). Kept
 * as an open record so the web can pass `deriveAutoContexts(pathname)` output
 * verbatim without a domain-side mapping layer; the agent reads them as JSON.
 */
export const InvestigationContextRef = Schema.Record(Schema.String, Schema.Unknown)
export type InvestigationContextRef = Schema.Schema.Type<typeof InvestigationContextRef>

/** Investigation anchored to a typed incident (error / alert / anomaly). */
export class InvestigationIncidentSubject extends Schema.Class<InvestigationIncidentSubject>(
	"InvestigationIncidentSubject",
)({
	type: Schema.Literal("incident"),
	incidentKind: AiTriageIncidentKind,
	incidentId: Schema.String,
	issueId: Schema.optionalKey(ErrorIssueId),
}) {}

/** "Investigate something else completely" — a user question with optional context. */
export class InvestigationFreeformSubject extends Schema.Class<InvestigationFreeformSubject>(
	"InvestigationFreeformSubject",
)({
	type: Schema.Literal("freeform"),
	title: Schema.String,
	prompt: Schema.String,
	contextRefs: Schema.Array(InvestigationContextRef),
}) {}

/**
 * "Did the merged fix actually work?" — opened by the verification tick once a
 * linked pull request has merged and its quiet window has elapsed.
 *
 * A distinct subject rather than a freeform question because the answer is a
 * verdict, not a conversation: the run is bounded, the evidence is already
 * gathered (the deterministic occurrence split lives in the snapshot's facts),
 * and the agent's job is to confirm or refute a specific claim rather than to
 * diagnose an unknown. Carrying `verificationId` lets the verdict be applied
 * back to the exact row that asked for it, even after a retry re-armed the
 * window.
 */
export class InvestigationFixVerificationSubject extends Schema.Class<InvestigationFixVerificationSubject>(
	"InvestigationFixVerificationSubject",
)({
	type: Schema.Literal("fix_verification"),
	issueId: ErrorIssueId,
	verificationId: ErrorIssueVerificationId,
	pullRequestUrl: Schema.String,
	/** Builds the issue was seen from at merge time; the membership set. */
	baselineVersions: Schema.Array(Schema.String),
	mergedAt: IsoDateTimeString,
}) {}

export const InvestigationSubject = Schema.Union([
	InvestigationIncidentSubject,
	InvestigationFreeformSubject,
	InvestigationFixVerificationSubject,
]).annotate({ identifier: "@maple/InvestigationSubject", title: "Investigation Subject" })
export type InvestigationSubject = Schema.Schema.Type<typeof InvestigationSubject>

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
	InvestigationSubject.members.map((member) => member.fields.type.literal),
).annotate({ identifier: "@maple/InvestigationSubjectType", title: "Investigation Subject Type" })
export type InvestigationSubjectType = Schema.Schema.Type<typeof InvestigationSubjectType>

/** A stored subject, read for its discriminator alone. See {@link InvestigationSubjectType}. */
export const InvestigationSubjectDiscriminator = Schema.Struct({
	type: InvestigationSubjectType,
}).annotate({ identifier: "@maple/InvestigationSubjectDiscriminator" })

/**
 * Stable, normalized rendering context captured when an investigation is
 * opened. It deliberately contains display-ready strings instead of source
 * table identifiers so old investigations remain understandable after the
 * originating telemetry or incident has expired.
 */
export class InvestigationSnapshotFact extends Schema.Class<InvestigationSnapshotFact>(
	"InvestigationSnapshotFact",
)({
	label: Schema.String,
	value: Schema.String,
}) {}

export class InvestigationSnapshotReference extends Schema.Class<InvestigationSnapshotReference>(
	"InvestigationSnapshotReference",
)({
	label: Schema.String,
	url: Schema.String,
}) {}

export class InvestigationSubjectSnapshot extends Schema.Class<InvestigationSubjectSnapshot>(
	"InvestigationSubjectSnapshot",
)({
	title: Schema.String,
	scope: Schema.NullOr(Schema.String),
	status: Schema.String,
	severity: Schema.NullOr(IssueSeverity),
	facts: Schema.Array(InvestigationSnapshotFact),
	references: Schema.Array(InvestigationSnapshotReference),
	incidentStartedAt: Schema.NullOr(IsoDateTimeString),
	incidentEndedAt: Schema.NullOr(IsoDateTimeString),

	// The identifiers an agent needs to *act*, as opposed to the display facts
	// above. These were being thrown away at the producer: the incident-open path
	// already carried the fingerprint, the exception and the first/last-seen
	// timestamps, and the snapshot kept none of them — so the prompt could tell the
	// agent to "establish the exact incident interval" and to "call error_detail
	// with the fingerprint" while handing it neither. Every one is `optionalKey`
	// so the snapshots already stored still decode unchanged.
	/** The error group's fingerprint. `error_detail` cannot be called without it. */
	fingerprintHash: Schema.optionalKey(Schema.NullOr(Schema.String)),
	exceptionType: Schema.optionalKey(Schema.NullOr(Schema.String)),
	exceptionMessage: Schema.optionalKey(Schema.NullOr(Schema.String)),
	topFrame: Schema.optionalKey(Schema.NullOr(Schema.String)),
	errorLabel: Schema.optionalKey(Schema.NullOr(Schema.String)),
	occurrenceCount: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	serviceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
	deploymentEnv: Schema.optionalKey(Schema.NullOr(Schema.String)),
	/** Alert and anomaly subjects: which signal fired, and against what. */
	signalType: Schema.optionalKey(Schema.NullOr(Schema.String)),
	observedValue: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	thresholdValue: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}) {}

// Documents

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

// Requests

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
}) {}

// Errors

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
