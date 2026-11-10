// Stored shapes shared by the HTTP contract (`./http/investigations.ts`) and the Postgres tables.

import { IssueSeverity } from "./error-issues"
import { AiTriageIncidentKind } from "./ai-triage"
import { ErrorIssueId, ErrorIssueVerificationId, IsoDateTimeString } from "@maple/primitives"
import { Schema } from "effect"

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

/** One thing the pass did. `tool` stays beside the display `label` because it is the only part worth matching on later. */
export const InvestigationStep = Schema.Struct({
	tool: Schema.String,
	label: Schema.String,
	at: Schema.Number,
}).annotate({ identifier: "@maple/InvestigationStep", title: "Investigation Step" })
export type InvestigationStep = Schema.Schema.Type<typeof InvestigationStep>

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
