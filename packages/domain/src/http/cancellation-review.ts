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

/** A count or a number of days: a whole number, never negative. */
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
/** A volume in GB: finite, never negative. */
const Volume = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

/** `scheduled`: cancels at period end, access continues. `ended`: the plan is gone now. */
export const CancellationPhase = Schema.Literals(["scheduled", "ended"])
export type CancellationPhase = Schema.Schema.Type<typeof CancellationPhase>

/** Billable volume over one 30-day window, in the units the plan is metered in. */
export const CancellationVolume = Schema.Struct({
	logsGB: Volume,
	tracesGB: Volume,
	metricsGB: Volume,
	browserSessions: Count,
	/** Days in the window on which anything arrived. */
	activeDays: Count,
})
export type CancellationVolume = Schema.Schema.Type<typeof CancellationVolume>

/** People from the org using the app over one 30-day window. */
export const CancellationVisits = Schema.Struct({
	/** Days in the window on which someone opened the app. */
	activeDays: Count,
	/** The most distinct people seen on a single day. */
	peakDailyUsers: Count,
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
		tenureDays: Schema.NullOr(Count),
		/** Days of paid access left; 0 once ended. */
		daysUntilEnd: Schema.NullOr(Count),
	}),
	org: Schema.NullOr(
		Schema.Struct({
			ageDays: Schema.NullOr(Count),
			members: Schema.NullOr(Count),
			onboardingCompleted: Schema.Boolean,
			/** Telemetry reached the org at some point in the last year. */
			everReceivedData: Schema.Boolean,
			supportChannel: Schema.Boolean,
		}),
	),
	ingest: Schema.NullOr(
		Schema.Struct({
			recent: CancellationVolume,
			prior: CancellationVolume,
			/** Looks back a year, past both windows. Null when nothing arrived in it. */
			daysSinceLastData: Schema.NullOr(Count),
		}),
	),
	visits: Schema.NullOr(
		Schema.Struct({
			recent: CancellationVisits,
			prior: CancellationVisits,
			/** Null when nobody opened the app in either window. */
			daysSinceLastVisit: Schema.NullOr(Count),
		}),
	),
	adoption: Schema.NullOr(
		Schema.Struct({
			dashboards: Count,
			alertRules: Count,
			alertDestinations: Count,
			apiKeys: Count,
			integrations: Count,
			investigations: Count,
		}),
	),
	billing: Schema.NullOr(
		Schema.Struct({
			invoices: Count,
			/** Dollars; a credit note is negative. Null with no invoice yet. */
			lastInvoiceTotal: Schema.NullOr(Schema.Finite),
			previousInvoiceTotal: Schema.NullOr(Schema.Finite),
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
