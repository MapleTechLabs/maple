/**
 * The cancelling customer's billing history, from Stripe and Autumn. Times are
 * whole days before the cancellation (negative after it); money is in dollars.
 * A `null` part could not be read; an empty list or a zero was read and is empty.
 */
import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Dollars = Schema.Finite

/** Why Stripe ended the subscription: the customer asked, a payment failed, or a payment was disputed. */
export const CancellationStripeReason = Schema.Literals([
	"cancellation_requested",
	"payment_failed",
	"payment_disputed",
])
export type CancellationStripeReason = Schema.Schema.Type<typeof CancellationStripeReason>

export const CancellationBillingInterval = Schema.Literals(["day", "week", "month", "year"])
export type CancellationBillingInterval = Schema.Schema.Type<typeof CancellationBillingInterval>

/** The cancelled Stripe subscription. */
export const CancellationReviewedSubscription = Schema.Struct({
	/** Stripe's reason for the cancellation; null when Stripe recorded none. */
	stripeCancellationReason: Schema.NullOr(CancellationStripeReason),
	/** Days from the subscription's start to the cancellation. */
	startedDaysBeforeCancel: Schema.Int,
	/** Trial start and end; both null when the subscription had no trial. */
	trialStartedDaysBeforeCancel: Schema.NullOr(Schema.Int),
	trialEndedDaysBeforeCancel: Schema.NullOr(Schema.Int),
	/** How often it billed; null when no item has a recurring price. */
	interval: Schema.NullOr(CancellationBillingInterval),
	/**
	 * Fixed price per interval, summed over its items; usage-billed charges are
	 * not included. Null when a fixed item has no flat unit price (tiered).
	 */
	pricePerIntervalDollars: Schema.NullOr(Dollars),
	/** The discount applied to it; null when none. */
	discount: Schema.NullOr(
		Schema.Struct({
			/** Percent off; null for a fixed-amount discount. */
			percentOff: Schema.NullOr(Schema.Finite),
			/** Dollars off; null for a percent discount. */
			amountOffDollars: Schema.NullOr(Dollars),
			duration: Schema.Literals(["once", "repeating", "forever"]),
			/** When the discount ends; null when it never does. */
			endsDaysBeforeCancel: Schema.NullOr(Schema.Int),
		}),
	),
})
export type CancellationReviewedSubscription = Schema.Schema.Type<typeof CancellationReviewedSubscription>

/**
 * Another Stripe subscription of the same customer started by the cancellation,
 * earlier plans and add-ons included; abandoned checkouts (`incomplete`,
 * `incomplete_expired`) are left out.
 */
export const CancellationOtherSubscription = Schema.Struct({
	startedDaysBeforeCancel: Schema.Int,
	/** Null when it was never cancelled. */
	canceledDaysBeforeCancel: Schema.NullOr(Schema.Int),
	/**
	 * Cancelled within a day of another subscription starting: a switch to
	 * another plan, not the customer leaving.
	 */
	switchedPlan: Schema.Boolean,
	/** Stripe's status now: `active`, `canceled`, `trialing`, `past_due`, ... */
	status: Schema.String,
	/** The cancellation survey's answer code (`too_expensive`, `unused`, ...); null when none. */
	surveyFeedback: Schema.NullOr(Schema.String),
})
export type CancellationOtherSubscription = Schema.Schema.Type<typeof CancellationOtherSubscription>

export const CancellationInvoice = Schema.Struct({
	daysBeforeCancel: Schema.Int,
	totalDollars: Dollars,
	/** Stripe's invoice status: `paid`, `open`, `uncollectible`, `void`, `draft`. */
	status: Schema.String,
	/** Autumn plan ids the invoice billed; empty when Autumn names none. */
	planIds: Schema.Array(Schema.String),
})
export type CancellationInvoice = Schema.Schema.Type<typeof CancellationInvoice>

export const CancellationBillingEvidence = Schema.Struct({
	/** From Stripe's subscription list; null when it could not be read or there is no Stripe customer. */
	subscriptions: Schema.NullOr(
		Schema.Struct({
			/** The subscription cancelled within two days of the cancellation; null when Stripe has none. */
			reviewed: Schema.NullOr(CancellationReviewedSubscription),
			/** Every other subscription of the customer, newest start first, at most 10. */
			others: Schema.Array(CancellationOtherSubscription),
		}),
	),
	/** Autumn's invoices of the customer, all of them as Autumn returns them; null when unreadable. */
	invoices: Schema.NullOr(
		Schema.Struct({
			/** Newest first, at most 12. */
			latest: Schema.Array(CancellationInvoice),
			paid: Count,
			open: Count,
			uncollectible: Count,
			/** The first paid invoice; null when none was paid. */
			firstPaidDaysBeforeCancel: Schema.NullOr(Schema.Int),
		}),
	),
	/** The customer's own billing controls in Autumn; null when unreadable. */
	billingControls: Schema.NullOr(
		Schema.Struct({
			/** At least one enabled cap on paid overage. */
			spendLimitSet: Schema.Boolean,
			/** At least one enabled usage alert. */
			usageAlertSet: Schema.Boolean,
		}),
	),
	/**
	 * Stripe charges from 180 days before the cancellation on, among the
	 * customer's latest 20; null when unreadable (the key lacks Charges read)
	 * or there is no Stripe customer.
	 */
	charges: Schema.NullOr(
		Schema.Struct({
			failed: Count,
			/** Stripe's failure code of the newest failed charge (`card_declined`, ...); null when none failed. */
			latestFailureCode: Schema.NullOr(Schema.String),
			/** Charges refunded in full or in part. */
			refunded: Count,
			disputed: Count,
		}),
	),
})
export type CancellationBillingEvidence = Schema.Schema.Type<typeof CancellationBillingEvidence>
