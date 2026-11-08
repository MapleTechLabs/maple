/**
 * Output schema for `get_investigation`: one investigation's diagnosis bundle, with every id in
 * its REST public form (`inv_…`, `iss_…`) so a local agent can hand them straight to other tools.
 */
import { Schema } from "effect"

export const InvestigationSubjectSummary = Schema.Struct({
	type: Schema.Literals(["incident", "freeform", "fix_verification"]),
	/** Incident subjects only: error, anomaly or alert. */
	incidentKind: Schema.NullOr(Schema.String),
	incidentId: Schema.NullOr(Schema.String),
	/** The linked `iss_…` error issue, when there is one. */
	issueId: Schema.NullOr(Schema.String),
	/** Freeform subjects: the question that was asked. */
	prompt: Schema.NullOr(Schema.String),
	/** Fix verification subjects: the merged pull request being checked. */
	pullRequestUrl: Schema.NullOr(Schema.String),
})

export const InvestigationSnapshotSummary = Schema.Struct({
	title: Schema.String,
	scope: Schema.NullOr(Schema.String),
	status: Schema.String,
	severity: Schema.NullOr(Schema.String),
	serviceName: Schema.NullOr(Schema.String),
	deploymentEnv: Schema.NullOr(Schema.String),
	fingerprintHash: Schema.NullOr(Schema.String),
	exceptionType: Schema.NullOr(Schema.String),
	exceptionMessage: Schema.NullOr(Schema.String),
	topFrame: Schema.NullOr(Schema.String),
	occurrenceCount: Schema.NullOr(Schema.Number),
	incidentStartedAt: Schema.NullOr(Schema.String),
	incidentEndedAt: Schema.NullOr(Schema.String),
	facts: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
	references: Schema.Array(Schema.Struct({ label: Schema.String, url: Schema.String })),
})

export const InvestigationEvidenceRow = Schema.Struct({
	traceIds: Schema.Array(Schema.String),
	logPatterns: Schema.Array(Schema.String),
	relatedServices: Schema.Array(Schema.String),
	note: Schema.String,
})

export const InvestigationReportSummary = Schema.Struct({
	headline: Schema.NullOr(Schema.String),
	summary: Schema.String,
	suspectedCause: Schema.String,
	confidence: Schema.String,
	severityAssessment: Schema.NullOr(Schema.String),
	affectedScope: Schema.String,
	evidence: Schema.Array(InvestigationEvidenceRow),
	suggestedActions: Schema.Array(Schema.String),
	ruledOut: Schema.Array(Schema.String),
	unchecked: Schema.Array(Schema.String),
	/** The commit the diagnosis blames, when it pinned the cause to one. */
	suspectCommit: Schema.NullOr(Schema.Struct({ sha: Schema.String, repo: Schema.NullOr(Schema.String) })),
})

export const GetInvestigationOutput = Schema.Struct({
	/** The `inv_…` public id. */
	id: Schema.String,
	status: Schema.String,
	subject: InvestigationSubjectSummary,
	snapshot: InvestigationSnapshotSummary,
	/** Null until the first diagnosis lands; a running investigation is not an error. */
	report: Schema.NullOr(InvestigationReportSummary),
	model: Schema.NullOr(Schema.String),
	severity: Schema.NullOr(Schema.String),
	confidence: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	diagnosedAt: Schema.NullOr(Schema.String),
	updatedAt: Schema.String,
})
