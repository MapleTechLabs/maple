import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import type { OrgId } from "@maple/domain/http"
import { camelizeKeys } from "@maple/backend/services/billing/autumn-http"
import { StripeClient, type StripeClientApi } from "@maple/backend/services/billing/stripe-http"
import {
	CancellationBillingEvidenceReader,
	billingControlsEvidenceOf,
	chargesEvidenceOf,
	invoicesEvidenceOf,
	reviewedSubscriptionOf,
	subscriptionsEvidenceOf,
} from "./evidence-billing"
import type { CancellationEvidenceInput } from "./evidence-input"

const DAY_S = 86_400
const DAY_MS = DAY_S * 1000
const CANCELLED_S = 1_760_000_000
const AT_MS = CANCELLED_S * 1000

/** A Stripe subscription as the API sends it, snake_case; the client camelises it. */
const stripeSubscription = (fields: Record<string, unknown>) => ({
	status: "canceled",
	start_date: CANCELLED_S - 100 * DAY_S,
	canceled_at: null,
	trial_start: null,
	trial_end: null,
	cancellation_details: { reason: null, feedback: null, comment: null },
	items: {
		data: [
			{
				quantity: 1,
				price: { unit_amount: 3900, recurring: { interval: "month", usage_type: "licensed" } },
			},
		],
	},
	discounts: [],
	...fields,
})

const subscriptions = (data: ReadonlyArray<Record<string, unknown>>) =>
	Effect.runSync(subscriptionsEvidenceOf(camelizeKeys({ data }), AT_MS))

describe("reviewedSubscriptionOf", () => {
	it("picks the cancellation closest to the reviewed one and ignores those days apart", () => {
		const earlier = { canceledAt: CANCELLED_S - 90 * DAY_S }
		const addOn = { canceledAt: CANCELLED_S + DAY_S }
		const plan = { canceledAt: CANCELLED_S + 60 }
		expect(reviewedSubscriptionOf([earlier, addOn, plan, { canceledAt: null }], AT_MS)).toBe(plan)
		expect(reviewedSubscriptionOf([earlier], AT_MS)).toBeUndefined()
	})
})

describe("subscriptionsEvidenceOf", () => {
	it("reads the other subscriptions as they stood at the cancellation", () => {
		const result = subscriptions([
			stripeSubscription({ start_date: CANCELLED_S - 45 * DAY_S, canceled_at: CANCELLED_S }),
			// An add-on cancelled a week later was still running then, its survey not yet given.
			stripeSubscription({
				start_date: CANCELLED_S - 40 * DAY_S,
				canceled_at: CANCELLED_S + 7 * DAY_S,
				status: "canceled",
				cancellation_details: { reason: "cancellation_requested", feedback: "unused", comment: null },
			}),
			// A resubscription after it is not part of why the org left.
			stripeSubscription({ start_date: CANCELLED_S + 3 * DAY_S }),
		])
		expect(result.others).toEqual([
			{
				startedDaysBeforeCancel: 40,
				canceledDaysBeforeCancel: null,
				switchedPlan: false,
				status: "active",
				surveyFeedback: null,
			},
		])
	})

	it("reads the cancelled subscription's terms, trial and discount in days and dollars", () => {
		const result = subscriptions([
			stripeSubscription({
				start_date: CANCELLED_S - 45 * DAY_S,
				canceled_at: CANCELLED_S + 60,
				trial_start: CANCELLED_S - 45 * DAY_S,
				trial_end: CANCELLED_S - 31 * DAY_S,
				cancellation_details: { reason: "payment_failed", feedback: null, comment: null },
				items: {
					data: [
						{
							quantity: 2,
							price: {
								unit_amount: 2500,
								recurring: { interval: "year", usage_type: "licensed" },
							},
						},
						// A usage-billed price's amount is per unit: not part of what the year costs.
						{
							price: {
								unit_amount: 50,
								recurring: { interval: "year", usage_type: "metered" },
							},
						},
					],
				},
				discounts: [
					{
						end: CANCELLED_S + 10 * DAY_S,
						coupon: { percent_off: null, amount_off: 1000, duration: "repeating" },
					},
				],
			}),
		])
		expect(result.reviewed).toEqual({
			stripeCancellationReason: "payment_failed",
			startedDaysBeforeCancel: 45,
			trialStartedDaysBeforeCancel: 45,
			trialEndedDaysBeforeCancel: 31,
			interval: "year",
			pricePerIntervalDollars: 50,
			discount: {
				percentOff: null,
				amountOffDollars: 10,
				duration: "repeating",
				endsDaysBeforeCancel: -10,
			},
		})
		expect(result.others).toEqual([])
	})

	it("lists the other subscriptions newest first with their survey code, never the comment", () => {
		const result = subscriptions([
			stripeSubscription({
				start_date: CANCELLED_S - 400 * DAY_S,
				canceled_at: CANCELLED_S - 300 * DAY_S,
				cancellation_details: {
					reason: "cancellation_requested",
					feedback: "too_expensive",
					comment: "too much",
				},
			}),
			stripeSubscription({ start_date: CANCELLED_S - 20 * DAY_S, canceled_at: CANCELLED_S }),
			stripeSubscription({ status: "active", start_date: CANCELLED_S - 10 * DAY_S }),
		])
		expect(result.reviewed?.startedDaysBeforeCancel).toBe(20)
		expect(result.others).toEqual([
			{
				startedDaysBeforeCancel: 10,
				canceledDaysBeforeCancel: null,
				switchedPlan: false,
				status: "active",
				surveyFeedback: null,
			},
			{
				startedDaysBeforeCancel: 400,
				canceledDaysBeforeCancel: 300,
				switchedPlan: false,
				status: "canceled",
				surveyFeedback: "too_expensive",
			},
		])
	})

	it("has no reviewed subscription when none was cancelled at the reviewed time", () => {
		const result = subscriptions([stripeSubscription({ canceled_at: CANCELLED_S - 60 * DAY_S })])
		expect(result.reviewed).toBeNull()
		expect(result.others).toHaveLength(1)
	})

	it("leaves out abandoned checkouts", () => {
		const result = subscriptions([
			stripeSubscription({ canceled_at: CANCELLED_S }),
			stripeSubscription({ status: "incomplete_expired", start_date: CANCELLED_S - 5 * DAY_S }),
			stripeSubscription({ status: "incomplete", start_date: CANCELLED_S - 4 * DAY_S }),
		])
		expect(result.others).toEqual([])
	})

	it("marks a subscription cancelled as another one started as a plan switch", () => {
		const result = subscriptions([
			// Cancelled the hour the reviewed plan started: a switch.
			stripeSubscription({
				start_date: CANCELLED_S - 200 * DAY_S,
				canceled_at: CANCELLED_S - 60 * DAY_S - 3600,
			}),
			stripeSubscription({ start_date: CANCELLED_S - 60 * DAY_S, canceled_at: CANCELLED_S }),
			// Cancelled with nothing starting near it: a departure.
			stripeSubscription({
				start_date: CANCELLED_S - 400 * DAY_S,
				canceled_at: CANCELLED_S - 300 * DAY_S,
			}),
		])
		expect(result.others.map((sub) => [sub.startedDaysBeforeCancel, sub.switchedPlan])).toEqual([
			[200, true],
			[400, false],
		])
	})

	it("has no price for a tiered plan rather than a price of 0", () => {
		const result = subscriptions([
			stripeSubscription({
				canceled_at: CANCELLED_S,
				items: {
					data: [
						{
							quantity: 1,
							price: {
								unit_amount: null,
								recurring: { interval: "month", usage_type: "licensed" },
							},
						},
					],
				},
			}),
		])
		expect(result.reviewed?.pricePerIntervalDollars).toBeNull()
		expect(result.reviewed?.interval).toBe("month")
	})

	it("has no price for a plan billed entirely by usage rather than a price of 0", () => {
		const result = subscriptions([
			stripeSubscription({
				canceled_at: CANCELLED_S,
				items: {
					data: [
						{
							price: {
								unit_amount: 2,
								recurring: { interval: "month", usage_type: "metered" },
							},
						},
					],
				},
			}),
		])
		expect(result.reviewed?.pricePerIntervalDollars).toBeNull()
	})

	it("drops a reason Stripe may add later rather than passing it on unnamed", () => {
		const result = subscriptions([
			stripeSubscription({
				canceled_at: CANCELLED_S,
				cancellation_details: { reason: "some_new_reason", feedback: null, comment: null },
			}),
		])
		expect(result.reviewed?.stripeCancellationReason).toBeNull()
	})
})

describe("invoicesEvidenceOf", () => {
	const invoices = (list: ReadonlyArray<Record<string, unknown>> | undefined) =>
		Effect.runSync(invoicesEvidenceOf(camelizeKeys(list === undefined ? {} : { invoices: list }), AT_MS))

	it("counts payments, not a trial's $0 invoice, and lists the newest first", () => {
		expect(
			invoices([
				{ status: "paid", total: 0, created_at: AT_MS - 90 * DAY_MS, plan_ids: ["pro"] },
				{ status: "paid", total: 39, created_at: AT_MS - 60 * DAY_MS, plan_ids: ["pro"] },
				{ status: "uncollectible", total: 39, created_at: AT_MS - 30 * DAY_MS },
				{ status: "open", total: 39, created_at: AT_MS - 2 * DAY_MS, plan_ids: ["pro"] },
			]),
		).toEqual({
			latest: [
				{ daysBeforeCancel: 2, totalDollars: 39, status: "open", planIds: ["pro"] },
				{ daysBeforeCancel: 30, totalDollars: 39, status: "uncollectible", planIds: [] },
				{ daysBeforeCancel: 60, totalDollars: 39, status: "paid", planIds: ["pro"] },
				{ daysBeforeCancel: 90, totalDollars: 0, status: "paid", planIds: ["pro"] },
			],
			paid: 1,
			open: 1,
			uncollectible: 1,
			firstPaidDaysBeforeCancel: 60,
		})
	})

	it("reads a customer Autumn sent no invoices for as one with none", () => {
		expect(invoices(undefined)).toEqual({
			latest: [],
			paid: 0,
			open: 0,
			uncollectible: 0,
			firstPaidDaysBeforeCancel: null,
		})
	})

	it("shows the latest 12 but counts every invoice", () => {
		const monthly = Array.from({ length: 15 }, (_, index) => ({
			status: "paid",
			total: 39,
			created_at: AT_MS - (index + 1) * 30 * DAY_MS,
		}))
		const result = invoices(monthly)
		expect(result.latest).toHaveLength(12)
		expect(result.latest[0]?.daysBeforeCancel).toBe(30)
		expect(result.paid).toBe(15)
		expect(result.firstPaidDaysBeforeCancel).toBe(450)
	})
})

describe("billingControlsEvidenceOf", () => {
	const controls = (customer: Record<string, unknown>) =>
		Effect.runSync(billingControlsEvidenceOf(camelizeKeys(customer)))

	it("applies Autumn's defaults when `enabled` is omitted: limits off, alerts on", () => {
		expect(
			controls({
				billing_controls: {
					spend_limits: [{ feature_id: "logs", overage_limit: 100 }],
					usage_alerts: [{ feature_id: "logs", threshold: 80, threshold_type: "usage_percentage" }],
				},
			}),
		).toEqual({ spendLimitSet: false, usageAlertSet: true })
	})

	it("reads disabled controls and a customer without any as nothing set", () => {
		expect(
			controls({
				billing_controls: {
					spend_limits: [{ enabled: false }],
					usage_alerts: [{ enabled: false }],
				},
			}),
		).toEqual({ spendLimitSet: false, usageAlertSet: false })
		expect(controls({})).toEqual({ spendLimitSet: false, usageAlertSet: false })
	})
})

describe("chargesEvidenceOf", () => {
	const charge = (fields: Record<string, unknown>) => ({
		created: CANCELLED_S - DAY_S,
		status: "succeeded",
		failure_code: null,
		amount_refunded: 0,
		disputed: false,
		...fields,
	})

	it("counts failures, refunds and disputes in the 180 days before the cancellation", () => {
		expect(
			Effect.runSync(
				chargesEvidenceOf(
					camelizeKeys({
						data: [
							charge({
								status: "failed",
								failure_code: "card_declined",
								created: CANCELLED_S - 3 * DAY_S,
							}),
							charge({
								status: "failed",
								failure_code: "expired_card",
								created: CANCELLED_S - 40 * DAY_S,
							}),
							charge({ amount_refunded: 1000 }),
							charge({ disputed: true }),
							// Outside the window.
							charge({
								status: "failed",
								failure_code: "fraudulent",
								created: CANCELLED_S - 200 * DAY_S,
							}),
						],
					}),
					AT_MS,
				),
			),
		).toEqual({ failed: 2, latestFailureCode: "card_declined", refunded: 1, disputed: 1 })
	})
})

describe("CancellationBillingEvidenceReader.read", () => {
	const input: CancellationEvidenceInput = {
		orgId: "org_test" as OrgId,
		atMs: AT_MS,
		autumnCustomer: camelizeKeys({
			invoices: [{ status: "paid", total: 39, created_at: AT_MS - DAY_MS }],
		}),
		stripeCustomerId: "cus_test",
		ownOrgId: null,
		members: null,
	}

	const readWith = (stripe: Pick<StripeClientApi, "listSubscriptions" | "listCharges">, at = input) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const evidence = yield* CancellationBillingEvidenceReader
				return yield* evidence.read(at)
			}).pipe(
				Effect.provide(
					Layer.effect(
						CancellationBillingEvidenceReader,
						CancellationBillingEvidenceReader.make,
					).pipe(Layer.provide(Layer.succeed(StripeClient, stripe as StripeClientApi))),
				),
			),
		)

	const subscriptionList = Effect.succeed({
		statusCode: 200,
		response: camelizeKeys({ data: [stripeSubscription({ canceled_at: CANCELLED_S })] }),
	})

	it("loses only the charges when the key may not read them", async () => {
		const result = await readWith({
			listSubscriptions: () => subscriptionList,
			listCharges: () =>
				Effect.succeed({
					statusCode: 403,
					response: {
						message: "The provided key does not have the required permissions",
						code: "x",
						statusCode: 403,
					},
				}),
		})
		expect(result.charges).toBeNull()
		expect(result.subscriptions?.reviewed?.pricePerIntervalDollars).toBe(39)
		expect(result.invoices?.paid).toBe(1)
		expect(result.billingControls).toEqual({ spendLimitSet: false, usageAlertSet: false })
	})

	it("reads nothing from Stripe for a customer Stripe does not have", async () => {
		const result = await readWith(
			{
				listSubscriptions: () => Effect.die("unreachable"),
				listCharges: () => Effect.die("unreachable"),
			},
			{ ...input, stripeCustomerId: null },
		)
		expect(result.subscriptions).toBeNull()
		expect(result.charges).toBeNull()
		expect(result.invoices?.paid).toBe(1)
	})
})
