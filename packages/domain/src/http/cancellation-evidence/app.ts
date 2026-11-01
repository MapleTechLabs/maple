/**
 * What the org set up and used inside Maple, read from Postgres: integration
 * health, onboarding, alerts, anomalies, investigations, error triage, agent
 * feedback, earlier cancellations, scrape targets, API keys and the digest.
 *
 * Each part is null when it could not be read. Inside a part, zero and empty
 * mean "read, nothing there"; a nullable field inside a part says what its null
 * means. "Recent" is the 30 days before the cancellation, "prior" the 30 before
 * that. Everything is as of the cancellation (plus an hour) where a timestamp
 * allows; a field read from current state says "now".
 */
import { Schema } from "effect"
import { SOURCE_HEALTH_STATUSES } from "../../source-health"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
/** Whole days before the cancellation; negative after it. */
const Days = Schema.Int
const Share = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/** An error message reduced to its kind; the message itself is never shown. */
export const CancellationErrorClass = Schema.Literals([
	"auth",
	"rate_limited",
	"not_found",
	"timeout",
	"unreachable",
	"other",
])
export type CancellationErrorClass = Schema.Schema.Type<typeof CancellationErrorClass>

export const CancellationIntegrationHealth = Schema.Struct({
	/** The integration (`github`, `cloudflare`, `prometheus`, ...) or the ingest source platform (`opentelemetry`, `nodejs`, `gcp`, ...). */
	kind: Schema.String,
	/** Health now, when the review ran (not as of the cancellation), worst of its resources and sources: disconnected, failing, stale, paused, pending or healthy. */
	status: Schema.Literals(SOURCE_HEALTH_STATUSES),
	/** Newest successful poll or data arrival; null when never, or when the integration does not record it. */
	lastSuccessDaysBeforeCancel: Schema.NullOr(Days),
	/** Newest refused ingest request (sources only); null when none is recorded before the cancellation. */
	lastErrorDaysBeforeCancel: Schema.NullOr(Days),
	/** Kind of the error behind a failing or disconnected `status`, or a GCP connector's current error; like `status`, as of now. Null when neither. */
	errorClass: Schema.NullOr(CancellationErrorClass),
})
export type CancellationIntegrationHealth = Schema.Schema.Type<typeof CancellationIntegrationHealth>

export const CancellationLifecycleEmail = Schema.Literals([
	"welcome",
	"connect_nudge",
	"stalled",
	"activation",
])
export type CancellationLifecycleEmail = Schema.Schema.Type<typeof CancellationLifecycleEmail>

export const CancellationOnboardingEvidence = Schema.Struct({
	/** False when the org never reached the onboarding flow; every other field is then false, null or empty. */
	recorded: Schema.Boolean,
	/** The onboarding flow was finished before the cancellation. */
	completed: Schema.Boolean,
	/** The getting-started checklist was dismissed before the cancellation. */
	checklistDismissed: Schema.Boolean,
	/** Demo data was asked for during onboarding. */
	demoDataRequested: Schema.Boolean,
	/** First telemetry the org sent; null when it sent none before the cancellation. */
	firstDataDaysBeforeCancel: Schema.NullOr(Days),
	/** Days from starting onboarding to the first telemetry; null when it never sent any. */
	signupToFirstDataDays: Schema.NullOr(Count),
	/** Onboarding emails Maple sent the org before the cancellation, in send order. */
	lifecycleEmailsSent: Schema.Array(CancellationLifecycleEmail),
})
export type CancellationOnboardingEvidence = Schema.Schema.Type<typeof CancellationOnboardingEvidence>

/** `manual`: switched off by a person. `recipient_left`: its last recipient left the org. Otherwise auto-disabled after repeated failed deliveries, by the kind of failure. */
export const CancellationDestinationDisabledReason = Schema.Literals([
	"manual",
	"recipient_left",
	...CancellationErrorClass.literals,
])

export const CancellationAlertsEvidence = Schema.Struct({
	/** Alert rules that existed at the cancellation and are switched on now. */
	enabledRules: Count,
	/** Alert rules that existed at the cancellation and are switched off now. */
	disabledRules: Count,
	/** Of the enabled rules, those whose latest evaluation (now) errored: the rule cannot be checked. */
	failingRules: Count,
	/** Alert incidents opened in the recent window. */
	incidentsRecent: Count,
	/** Alert incidents opened in the prior window. */
	incidentsPrior: Count,
	/** Median minutes from open to resolve of the recent window's resolved incidents; null when none resolved. */
	medianIncidentMinutesRecent: Schema.NullOr(Count),
	/** Notification delivery attempts that succeeded in the recent window. */
	notificationsSentRecent: Count,
	/** Notification delivery attempts that failed in the recent window. */
	deliveryFailuresRecent: Count,
	/** Notification destinations (Slack, webhook, ...) that existed at the cancellation. */
	destinations: Count,
	/** Of those, disabled at the cancellation, by type and why; one a person switched off counts as of now. At most 10. */
	disabledDestinations: Schema.Array(
		Schema.Struct({ type: Schema.String, reason: CancellationDestinationDisabledReason }),
	),
})
export type CancellationAlertsEvidence = Schema.Schema.Type<typeof CancellationAlertsEvidence>

export const CancellationAnomaliesEvidence = Schema.Struct({
	/** Anomaly incidents opened in the recent window. */
	incidentsRecent: Count,
	/** Of those, incidents that resolved and fired again at least once. */
	reopenedRecent: Count,
	/** False when the org has the anomaly detector switched off now. */
	detectorEnabled: Schema.Boolean,
	/** Signals the org has muted now (`latency`, `error_rate`, ...); at most 10. */
	mutedSignals: Schema.Array(Schema.String),
})
export type CancellationAnomaliesEvidence = Schema.Schema.Type<typeof CancellationAnomaliesEvidence>

export const CancellationInvestigationsEvidence = Schema.Struct({
	/** AI investigations started in the recent window. */
	recent: Count,
	/** Of those, started by a person. */
	userStarted: Count,
	/** Of those, started automatically by an incident. */
	automatic: Count,
	/** Of those, ended without a report (the agent broke). */
	failed: Count,
	/** Of those, inconclusive or diagnosed with `low` confidence. */
	lowConfidence: Count,
})
export type CancellationInvestigationsEvidence = Schema.Schema.Type<typeof CancellationInvestigationsEvidence>

export const CancellationErrorIssuesEvidence = Schema.Struct({
	/** Error issues open at the cancellation: seen by then, not archived or resolved by then; issues closed without a resolution count as of now. */
	open: Count,
	/** Error issues first seen in the recent window. */
	firstSeenRecent: Count,
	/** Issue actions by a person (state changes, comments, assignments, ...) in the recent window. */
	userActionsRecent: Count,
	/** The same in the prior window. */
	userActionsPrior: Count,
})
export type CancellationErrorIssuesEvidence = Schema.Schema.Type<typeof CancellationErrorIssuesEvidence>

/** Feedback about Maple that the org's coding or chat agents sent, newest first. */
export const CancellationAgentFeedback = Schema.Struct({
	daysBeforeCancel: Days,
	/** `bug`, `feature_request`, `improvement`, `documentation`, `praise` or `other`. */
	kind: Schema.String,
	/** `blocking`, `degraded` or `minor`; null when the agent did not say. */
	impact: Schema.NullOr(Schema.String),
	/** The agent's one-line summary, emails redacted, at most 200 characters. */
	summary: Schema.String,
})
export type CancellationAgentFeedback = Schema.Schema.Type<typeof CancellationAgentFeedback>

/** An earlier cancellation of this org that was reviewed and reported. */
export const CancellationPriorReview = Schema.Struct({
	daysBeforeCancel: Days,
	/** The reason the fixed rules read then; null when none was stored. */
	ruleReason: Schema.NullOr(Schema.String),
	/** The model's category when it overrode the rules then; null when it agreed or did not answer. */
	modelCategory: Schema.NullOr(Schema.String),
})
export type CancellationPriorReview = Schema.Schema.Type<typeof CancellationPriorReview>

export const CancellationScrapeEvidence = Schema.Struct({
	/** Prometheus scrape targets that existed at the cancellation, including ones an integration manages. */
	targets: Count,
	/** Of those, switched on now. */
	enabledTargets: Count,
	/** Scrape attempts in the day before the cancellation, over at most 200 targets; null when the review ran more than an hour after it (history is kept 24 hours). */
	checksLastDay: Schema.NullOr(Count),
	/** Share of those attempts that failed, 0 to 1; null when there were none or they were not read. */
	failedCheckShareLastDay: Schema.NullOr(Share),
	/** Newest successful scrape of any target; null when none ever succeeded. */
	lastSuccessDaysBeforeCancel: Schema.NullOr(Days),
})
export type CancellationScrapeEvidence = Schema.Schema.Type<typeof CancellationScrapeEvidence>

export const CancellationApiKeysEvidence = Schema.Struct({
	/** Keys usable at the cancellation (created by then, not revoked or expired by then), by kind: `standard` (API), `mcp` (MCP clients), `device` (CLI logins). */
	active: Schema.Struct({ standard: Count, mcp: Count, device: Count }),
	/** Newest use of any key created by the cancellation, revoked ones included; 0 when one was still used at or after it; null when none was ever used. */
	lastUsedDaysBeforeCancel: Schema.NullOr(Days),
})
export type CancellationApiKeysEvidence = Schema.Schema.Type<typeof CancellationApiKeysEvidence>

export const CancellationDigestEvidence = Schema.Struct({
	/** Members receiving the weekly ops digest at the cancellation; one switched off without opting out (a member who left) counts as of now. */
	subscribers: Count,
	/** Members who had turned the digest off themselves by the cancellation. */
	optedOut: Count,
	/** Newest such opt-out; null when nobody opted out. */
	lastOptOutDaysBeforeCancel: Schema.NullOr(Days),
})
export type CancellationDigestEvidence = Schema.Schema.Type<typeof CancellationDigestEvidence>

export const CancellationAppEvidence = Schema.Struct({
	/** Connected integrations and ingest sources, worst status first; at most 15. */
	integrations: Schema.NullOr(Schema.Array(CancellationIntegrationHealth)),
	onboarding: Schema.NullOr(CancellationOnboardingEvidence),
	alerts: Schema.NullOr(CancellationAlertsEvidence),
	anomalies: Schema.NullOr(CancellationAnomaliesEvidence),
	investigations: Schema.NullOr(CancellationInvestigationsEvidence),
	errorIssues: Schema.NullOr(CancellationErrorIssuesEvidence),
	/** Newest 5 within the 90 days before the cancellation. */
	agentFeedback: Schema.NullOr(Schema.Array(CancellationAgentFeedback)),
	/** Newest 5; the cancellation being reviewed (within 2 days of it) is excluded. */
	priorCancellations: Schema.NullOr(Schema.Array(CancellationPriorReview)),
	scrapeTargets: Schema.NullOr(CancellationScrapeEvidence),
	apiKeys: Schema.NullOr(CancellationApiKeysEvidence),
	digest: Schema.NullOr(CancellationDigestEvidence),
})
export type CancellationAppEvidence = Schema.Schema.Type<typeof CancellationAppEvidence>
