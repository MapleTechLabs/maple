/**
 * The billing evidence section: the cancelled Stripe subscription and the
 * customer's others, Autumn's invoices and billing controls, and Stripe's
 * recent charges. Each part is read on its own and is `null` when it cannot be.
 */
import type {
	CancellationBillingEvidence as BillingEvidence,
	CancellationInvoice,
	CancellationOtherSubscription,
	CancellationReviewedSubscription,
} from "@maple/domain/http"
import { CancellationBillingInterval, CancellationStripeReason } from "@maple/domain/http"
import { Option, Cause, Context, Effect, Layer, Schema } from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { ensureOk } from "@maple/backend/services/billing/autumn-client"
import { StripeClient } from "@maple/backend/services/billing/stripe-http"
import { type CancellationEvidenceInput, daysBeforeCancel, knownAtCancel } from "./evidence-input"
import { DAY_MS } from "./snapshot"

/** Other subscriptions shown, newest first. */
export const OTHER_SUBSCRIPTIONS_SHOWN = 10
/** Invoices shown, newest first. */
export const INVOICES_SHOWN = 12
/** Charges older than this before the cancellation are not counted. */
const CHARGE_WINDOW_MS = 180 * DAY_MS
/** A Stripe cancellation this far from the reviewed one is another cancellation. */
const SAME_CANCELLATION_MS = 2 * DAY_MS
/** A subscription cancelled this close to another one starting was switched, not left. */
const PLAN_SWITCH_MS = DAY_MS
/** Abandoned checkouts: the first payment never went through. */
const ABANDONED_STATUSES = new Set(["incomplete", "incomplete_expired"])
/** Well under the review's whole-section timeout. */
const PART_TIMEOUT = "8 seconds"

const Nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

/** Stripe stamps seconds. */
const daysBefore = (atMs: number, seconds: number) => daysBeforeCancel(atMs, seconds * 1000)

/**
 * The Stripe subscription a cancellation at `atMs` ended: the one cancelled
 * within two days of it, the closest when a plan and an add-on were cancelled
 * together. Undefined when none was.
 */
export const reviewedSubscriptionOf = <S extends { readonly canceledAt?: number | null | undefined }>(
	subscriptions: ReadonlyArray<S>,
	atMs: number,
): S | undefined => {
	const distance = (sub: S) => Math.abs((sub.canceledAt ?? 0) * 1000 - atMs)
	return subscriptions
		.filter((sub) => sub.canceledAt != null && distance(sub) <= SAME_CANCELLATION_MS)
		.toSorted((a, b) => distance(a) - distance(b))[0]
}

/** Only what is read off Stripe's subscription list (camelised, discounts expanded). */
const StripeSubscriptions = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({
			status: Schema.String,
			startDate: Schema.Number,
			canceledAt: Nullable(Schema.Number),
			trialStart: Nullable(Schema.Number),
			trialEnd: Nullable(Schema.Number),
			cancellationDetails: Nullable(
				Schema.Struct({ reason: Nullable(Schema.String), feedback: Nullable(Schema.String) }),
			),
			items: Schema.Struct({
				data: Schema.Array(
					Schema.Struct({
						quantity: Nullable(Schema.Number),
						price: Schema.Struct({
							unitAmount: Nullable(Schema.Number),
							recurring: Nullable(
								Schema.Struct({
									interval: Schema.String,
									usageType: Nullable(Schema.String),
								}),
							),
						}),
					}),
				),
			}),
			// Read one by one below: a discount this cannot read loses the discount, not the list.
			discounts: Nullable(Schema.Array(Schema.Unknown)),
		}),
	),
})
type StripeSubscription = (typeof StripeSubscriptions.Type)["data"][number]

/** An expanded discount whose coupon came embedded; a bare coupon id reads as no discount. */
const StripeDiscount = Schema.Struct({
	end: Nullable(Schema.Number),
	coupon: Schema.Struct({
		percentOff: Nullable(Schema.Number),
		amountOff: Nullable(Schema.Number),
		duration: Schema.Literals(["once", "repeating", "forever"]),
	}),
})
const decodeDiscount = Schema.decodeUnknownOption(StripeDiscount)

const isStripeReason = Schema.is(CancellationStripeReason)
const isInterval = Schema.is(CancellationBillingInterval)

const reviewedOf = (sub: StripeSubscription, atMs: number): CancellationReviewedSubscription => {
	const reason = sub.cancellationDetails?.reason
	const interval = sub.items.data.find((item) => item.price.recurring != null)?.price.recurring?.interval
	// Usage-billed prices carry a per-unit amount, not what the interval costs.
	const fixed = sub.items.data.filter((item) => item.price.recurring?.usageType !== "metered")
	// A tiered price has no flat amount, and an all-metered plan has no fixed part:
	// either way the interval's cost is unknown, not 0.
	const fixedCents =
		fixed.length > 0 && fixed.every((item) => item.price.unitAmount != null)
			? fixed.reduce((sum, item) => sum + (item.price.unitAmount ?? 0) * (item.quantity ?? 1), 0)
			: null
	const discount = Option.getOrUndefined(decodeDiscount(sub.discounts?.[0]))
	return {
		stripeCancellationReason: isStripeReason(reason) ? reason : null,
		startedDaysBeforeCancel: daysBefore(atMs, sub.startDate),
		trialStartedDaysBeforeCancel: sub.trialStart == null ? null : daysBefore(atMs, sub.trialStart),
		trialEndedDaysBeforeCancel: sub.trialEnd == null ? null : daysBefore(atMs, sub.trialEnd),
		interval: isInterval(interval) ? interval : null,
		pricePerIntervalDollars: fixedCents === null ? null : fixedCents / 100,
		discount:
			discount === undefined
				? null
				: {
						percentOff: discount.coupon.percentOff ?? null,
						amountOffDollars:
							discount.coupon.amountOff == null ? null : discount.coupon.amountOff / 100,
						duration: discount.coupon.duration,
						endsDaysBeforeCancel: discount.end == null ? null : daysBefore(atMs, discount.end),
					},
	}
}

/** As it stood at the cancellation: one cancelled later was still running then. */
const otherOf = (
	sub: StripeSubscription,
	all: ReadonlyArray<StripeSubscription>,
	atMs: number,
): CancellationOtherSubscription => {
	const canceledAt =
		sub.canceledAt != null && knownAtCancel(atMs, sub.canceledAt * 1000) ? sub.canceledAt : null
	return {
		startedDaysBeforeCancel: daysBefore(atMs, sub.startDate),
		canceledDaysBeforeCancel: canceledAt === null ? null : daysBefore(atMs, canceledAt),
		switchedPlan: all.some(
			(next) =>
				next !== sub &&
				canceledAt !== null &&
				Math.abs(next.startDate - canceledAt) * 1000 <= PLAN_SWITCH_MS,
		),
		status: canceledAt === null && sub.canceledAt != null ? "active" : sub.status,
		surveyFeedback: canceledAt === null ? null : (sub.cancellationDetails?.feedback ?? null),
	}
}

/** The cancelled subscription and the customer's others, from Stripe's (camelised) subscription list. */
export const subscriptionsEvidenceOf = (response: unknown, atMs: number) =>
	Schema.decodeUnknownEffect(StripeSubscriptions)(response).pipe(
		Effect.map(({ data }): NonNullable<BillingEvidence["subscriptions"]> => {
			const reviewed = reviewedSubscriptionOf(data, atMs)
			const started = data.filter((sub) => !ABANDONED_STATUSES.has(sub.status))
			return {
				reviewed: reviewed === undefined ? null : reviewedOf(reviewed, atMs),
				others: started
					.filter((sub) => sub !== reviewed && knownAtCancel(atMs, sub.startDate * 1000))
					.toSorted((a, b) => b.startDate - a.startDate)
					.slice(0, OTHER_SUBSCRIPTIONS_SHOWN)
					.map((sub) => otherOf(sub, started, atMs)),
			}
		}),
	)

/** Autumn omits `invoices` for a customer that has none. `createdAt` is epoch ms, `total` dollars. */
const AutumnInvoices = Schema.Struct({
	invoices: Nullable(
		Schema.Array(
			Schema.Struct({
				status: Schema.String,
				total: Schema.Number,
				createdAt: Schema.Number,
				planIds: Nullable(Schema.Array(Schema.String)),
			}),
		),
	),
})

/**
 * Autumn's invoices of the customer. A paid invoice counts only with a
 * non-zero total: a trial's $0 invoice is not a payment.
 */
export const invoicesEvidenceOf = (customer: unknown, atMs: number) =>
	Schema.decodeUnknownEffect(AutumnInvoices)(customer).pipe(
		Effect.map(({ invoices }): NonNullable<BillingEvidence["invoices"]> => {
			const newestFirst = (invoices ?? [])
				.filter((invoice) => knownAtCancel(atMs, invoice.createdAt))
				.toSorted((a, b) => b.createdAt - a.createdAt)
			const paid = newestFirst.filter((invoice) => invoice.status === "paid" && invoice.total !== 0)
			const firstPaid = paid.at(-1)
			return {
				latest: newestFirst.slice(0, INVOICES_SHOWN).map((invoice): CancellationInvoice => ({
					daysBeforeCancel: daysBeforeCancel(atMs, invoice.createdAt),
					totalDollars: invoice.total,
					status: invoice.status,
					planIds: invoice.planIds ?? [],
				})),
				paid: paid.length,
				open: newestFirst.filter((invoice) => invoice.status === "open").length,
				uncollectible: newestFirst.filter((invoice) => invoice.status === "uncollectible").length,
				firstPaidDaysBeforeCancel:
					firstPaid === undefined ? null : daysBeforeCancel(atMs, firstPaid.createdAt),
			}
		}),
	)

/**
 * Autumn omits `enabled` when it is the default, and the defaults differ: a
 * spend limit is off unless said otherwise, a usage alert is on.
 */
const AutumnBillingControls = Schema.Struct({
	billingControls: Nullable(
		Schema.Struct({
			spendLimits: Nullable(Schema.Array(Schema.Struct({ enabled: Nullable(Schema.Boolean) }))),
			usageAlerts: Nullable(Schema.Array(Schema.Struct({ enabled: Nullable(Schema.Boolean) }))),
		}),
	),
})

export const billingControlsEvidenceOf = (customer: unknown) =>
	Schema.decodeUnknownEffect(AutumnBillingControls)(customer).pipe(
		Effect.map(({ billingControls }): NonNullable<BillingEvidence["billingControls"]> => ({
			spendLimitSet: (billingControls?.spendLimits ?? []).some((limit) => limit.enabled === true),
			usageAlertSet: (billingControls?.usageAlerts ?? []).some((alert) => alert.enabled !== false),
		})),
	)

/** Only what is read off Stripe's charge list, camelised. `created` is epoch seconds. */
const StripeCharges = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({
			created: Schema.Number,
			status: Schema.String,
			failureCode: Nullable(Schema.String),
			amountRefunded: Schema.Number,
			disputed: Schema.Boolean,
		}),
	),
})

/** The customer's charges in the 180 days up to the cancellation, from Stripe's (camelised) charge list. */
export const chargesEvidenceOf = (response: unknown, atMs: number) =>
	Schema.decodeUnknownEffect(StripeCharges)(response).pipe(
		Effect.map(({ data }): NonNullable<BillingEvidence["charges"]> => {
			const charges = data
				.filter(
					(charge) =>
						charge.created * 1000 >= atMs - CHARGE_WINDOW_MS &&
						knownAtCancel(atMs, charge.created * 1000),
				)
				.toSorted((a, b) => b.created - a.created)
			const failed = charges.filter((charge) => charge.status === "failed")
			return {
				failed: failed.length,
				latestFailureCode: failed[0]?.failureCode ?? null,
				refunded: charges.filter((charge) => charge.amountRefunded > 0).length,
				disputed: charges.filter((charge) => charge.disputed).length,
			}
		}),
	)

/** A part that fails or runs long is `null`, never the end of the section. */
const part = <A, E>(span: string, read: Effect.Effect<A, E>): Effect.Effect<A | null> =>
	read.pipe(
		Effect.timeout(PART_TIMEOUT),
		Effect.map((value): A | null => value),
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.logWarning("cancellation billing evidence could not read a part").pipe(
						Effect.annotateLogs({ part: span, error: summarizeCause(cause) }),
						Effect.as(null),
					),
		),
		Effect.withSpan(span),
	)

export class CancellationBillingEvidenceReader extends Context.Service<
	CancellationBillingEvidenceReader,
	{ readonly read: (input: CancellationEvidenceInput) => Effect.Effect<BillingEvidence> }
>()("@maple/backend/cancellation-review/CancellationBillingEvidenceReader", {
	make: Effect.gen(function* () {
		const stripe = yield* StripeClient

		const read = Effect.fn("CancellationBillingEvidenceReader.read")(function* (
			input: CancellationEvidenceInput,
		) {
			const { atMs, autumnCustomer, stripeCustomerId } = input
			// Without a Stripe customer there is nothing in Stripe to read.
			const fromStripe = <A, E>(span: string, read: (customerId: string) => Effect.Effect<A, E>) =>
				stripeCustomerId === null ? Effect.succeed(null) : part(span, read(stripeCustomerId))
			return yield* Effect.all(
				{
					subscriptions: fromStripe(
						"CancellationBillingEvidenceReader.readSubscriptions",
						(customerId) =>
							stripe.listSubscriptions(customerId).pipe(
								Effect.flatMap(ensureOk),
								Effect.flatMap((response) => subscriptionsEvidenceOf(response, atMs)),
							),
					),
					invoices: part(
						"CancellationBillingEvidenceReader.readInvoices",
						invoicesEvidenceOf(autumnCustomer, atMs),
					),
					billingControls: part(
						"CancellationBillingEvidenceReader.readBillingControls",
						billingControlsEvidenceOf(autumnCustomer),
					),
					// A key without Charges read answers 403: this part is null, the rest stands.
					charges: fromStripe("CancellationBillingEvidenceReader.readCharges", (customerId) =>
						stripe.listCharges(customerId).pipe(
							Effect.flatMap(ensureOk),
							Effect.flatMap((response) => chargesEvidenceOf(response, atMs)),
						),
					),
				},
				{ concurrency: "unbounded" },
			)
		})

		return { read }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(StripeClient.layer))
}
