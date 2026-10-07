/**
 * The cancellation review: what an org's own usage says about why it is leaving
 * a plan, gathered once when Autumn reports the cancellation.
 *
 * The snapshot is numbers and flags only. Names and addresses stay on the side
 * that posts the report; nothing here identifies a person, so the snapshot can
 * be handed to a model and stored as it is.
 */
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { IncidentTriageUnauthorizedError, TriageProbability } from "./incident-triage"

/** `scheduled`: cancels at period end, access continues. `ended`: the plan is gone now. */
export const CancellationPhase = Schema.Literals(["scheduled", "ended"])
export type CancellationPhase = Schema.Schema.Type<typeof CancellationPhase>

/** Billable volume over one 30-day window, in the units the plan is metered in. */
export const CancellationVolume = Schema.Struct({
	logsGB: Schema.Number,
	tracesGB: Schema.Number,
	metricsGB: Schema.Number,
	browserSessions: Schema.Number,
	/** Days in the window on which anything arrived. */
	activeDays: Schema.Number,
})
export type CancellationVolume = Schema.Schema.Type<typeof CancellationVolume>

/** People from the org using the app over one 30-day window. */
export const CancellationVisits = Schema.Struct({
	/** Days in the window on which someone opened the app. */
	activeDays: Schema.Number,
	/** The most distinct people seen on a single day. */
	peakDailyUsers: Schema.Number,
})
export type CancellationVisits = Schema.Schema.Type<typeof CancellationVisits>

/**
 * Every section but `plan` is nullable: a source that could not be read is
 * `null`, never zeros, so "no data" and "could not look" stay different facts.
 * `recent` is the 30 days up to the cancellation, `prior` the 30 before that.
 */
export class CancellationSnapshot extends Schema.Class<CancellationSnapshot>("CancellationSnapshot")({
	plan: Schema.Struct({
		planId: Schema.String,
		phase: CancellationPhase,
		trial: Schema.Boolean,
		pastDue: Schema.Boolean,
		/** Days from the subscription's start to the cancellation. */
		tenureDays: Schema.NullOr(Schema.Number),
		/** Days of paid access left; 0 once ended. */
		daysUntilEnd: Schema.NullOr(Schema.Number),
	}),
	org: Schema.NullOr(
		Schema.Struct({
			ageDays: Schema.NullOr(Schema.Number),
			members: Schema.NullOr(Schema.Number),
			onboardingCompleted: Schema.Boolean,
			/** Telemetry reached the org at least once, however long ago. */
			everReceivedData: Schema.Boolean,
			supportChannel: Schema.Boolean,
		}),
	),
	ingest: Schema.NullOr(
		Schema.Struct({
			recent: CancellationVolume,
			prior: CancellationVolume,
			/** Null when nothing arrived in either window. */
			daysSinceLastData: Schema.NullOr(Schema.Number),
		}),
	),
	visits: Schema.NullOr(
		Schema.Struct({
			recent: CancellationVisits,
			prior: CancellationVisits,
			/** Null when nobody opened the app in either window. */
			daysSinceLastVisit: Schema.NullOr(Schema.Number),
		}),
	),
	adoption: Schema.NullOr(
		Schema.Struct({
			dashboards: Schema.Number,
			alertRules: Schema.Number,
			alertDestinations: Schema.Number,
			apiKeys: Schema.Number,
			integrations: Schema.Number,
			investigations: Schema.Number,
		}),
	),
	billing: Schema.NullOr(
		Schema.Struct({
			invoices: Schema.Number,
			/** Dollars. Null with no invoice yet. */
			lastInvoiceTotal: Schema.NullOr(Schema.Number),
			previousInvoiceTotal: Schema.NullOr(Schema.Number),
			/** Metered features used past the plan's included allowance this cycle. */
			overAllowance: Schema.Array(Schema.String),
		}),
	),
}) {}

/**
 * Why the org is leaving, as far as its own usage shows. `unclear` is a real
 * answer: an org that was active to the last day did not leave over anything
 * the metrics record, and saying so is what sends a person to ask.
 */
export const CancellationReason = Schema.Literals([
	"never_activated",
	"stopped_sending",
	"not_engaged",
	"cost",
	"payment_failure",
	"unclear",
]).annotate({ identifier: "@maple/CancellationReason", title: "Cancellation Reason" })
export type CancellationReason = Schema.Schema.Type<typeof CancellationReason>

export class CancellationAssessment extends Schema.Class<CancellationAssessment>("CancellationAssessment")({
	reason: CancellationReason,
	/** The model's own probability for the reason it chose. */
	reasonConfidence: TriageProbability,
	/** How likely a personal note keeps or wins back the org. */
	winBack: TriageProbability,
	/** The model id that answered. */
	model: Schema.String,
}) {}

/** The decision model did not answer. The report is posted without an assessment. */
export class CancellationAssessmentModelError extends Schema.TaggedError<CancellationAssessmentModelError>()(
	"@maple/http/errors/CancellationAssessmentModelError",
	{ message: Schema.String },
	{ httpApiStatus: 502 },
) {}

/**
 * The assessment as maple-ai serves it to the api Worker's cancellation
 * consumer: internal service token, no tenant, nothing of the org's read or
 * written.
 */
export class CancellationReviewApiGroup extends HttpApiGroup.make("cancellation")
	.add(
		HttpApiEndpoint.post("assess", "/assess", {
			headers: Schema.Struct({ authorization: Schema.String }),
			payload: CancellationSnapshot,
			success: CancellationAssessment,
			error: [IncidentTriageUnauthorizedError, CancellationAssessmentModelError],
		}),
	)
	.prefix("/internal/cancellation") {}
