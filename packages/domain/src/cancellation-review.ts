// Stored shapes shared by the HTTP contract (`./http/cancellation-review.ts`) and the Postgres tables.

import { Schema } from "effect"

/** A count or a number of days: a whole number, never negative. */
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
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
			integrations: Count,
		}),
	),
	billing: Schema.NullOr(
		Schema.Struct({
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
	"same_day_cancel",
	"never_activated",
	"stopped_sending",
	"not_engaged",
	"cost",
	"payment_failure",
	"unclear",
]).annotate({ identifier: "@maple/CancellationReason", title: "Cancellation Reason" })
export type CancellationReason = Schema.Schema.Type<typeof CancellationReason>

/** `agree`: the rules' reason stands. `override`: the evidence shows a different one. */
export const CancellationModelVerdict = Schema.Literals(["agree", "override"])
export type CancellationModelVerdict = Schema.Schema.Type<typeof CancellationModelVerdict>

/**
 * An override's reason as a fixed label, so stored reads can be counted against
 * the rules' reasons and Stripe's survey answers. The rules' reasons, plus what
 * only the customer's own evidence shows.
 */
export const CancellationModelCategory = Schema.Literals([
	...CancellationReason.literals,
	"missing_features",
	"product_quality",
	"too_complex",
	"switched_service",
	"other",
])
export type CancellationModelCategory = Schema.Schema.Type<typeof CancellationModelCategory>

export const CancellationCompanyConfidence = Schema.Literals(["high", "medium", "low"])
export type CancellationCompanyConfidence = Schema.Schema.Type<typeof CancellationCompanyConfidence>

/** The model's best guess at who the customer is, from the company evidence. */
export const CancellationCompanyGuess = Schema.Struct({
	/** The company's name, or its domain when that is all there is; never a person's name. */
	name: Schema.String,
	/** What the company does, in one line; null when nothing says. */
	oneLiner: Schema.NullOr(Schema.String),
	/** City and/or country, when the evidence says. */
	location: Schema.NullOr(Schema.String),
	confidence: CancellationCompanyConfidence,
	/** The clues the guess rests on, in a few words. */
	basis: Schema.String,
})
export type CancellationCompanyGuess = Schema.Schema.Type<typeof CancellationCompanyGuess>

export class CancellationModelRead extends Schema.Class<CancellationModelRead>("CancellationModelRead")({
	/** Null when the evidence says nothing about who the customer is. */
	company: Schema.NullOr(CancellationCompanyGuess),
	/** What is unusual about this customer and bears on why it left, stated as fact. At most three; often none. */
	findings: Schema.Array(Schema.String),
	verdict: CancellationModelVerdict,
	/** The override's reason as a label; null on `agree`. */
	category: Schema.NullOr(CancellationModelCategory),
	/** The override's reason in a few words; null on `agree`. */
	reason: Schema.NullOr(Schema.String),
	/** The model's opinion on why the customer left, in one or two sentences. */
	conclusion: Schema.String,
	/** The model id that answered. */
	model: Schema.String,
}) {}
