import { describe, expect, it } from "@effect/vitest"
import { BillingCustomer, BillingInvoice, BillingSubscription } from "@maple/domain/http"
import {
	hasNeverPaid,
	isPastDue,
	OVERDUE_GRACE_MS,
	shouldSuspend,
} from "./BillingSuspensionPolicy"

const NOW = 1_700_000_000_000

const sub = (fields: Partial<{ pastDue: boolean; addOn: boolean; status: string }>) =>
	new BillingSubscription({
		planId: "startup",
		status: fields.status ?? "active",
		...(fields.addOn !== undefined ? { addOn: fields.addOn } : {}),
		...(fields.pastDue !== undefined ? { pastDue: fields.pastDue } : {}),
	})

const customer = (opts: {
	subs: ReadonlyArray<BillingSubscription>
	invoices?: ReadonlyArray<BillingInvoice>
}) =>
	new BillingCustomer({
		id: "org_x",
		subscriptions: opts.subs,
		...(opts.invoices !== undefined ? { invoices: opts.invoices } : {}),
	})

const invoice = (status: string) => new BillingInvoice({ stripeId: `in_${status}`, status })

describe("isPastDue", () => {
	it("is true when a non-add-on subscription is past_due", () => {
		expect(isPastDue(customer({ subs: [sub({ pastDue: true })] }))).toBe(true)
	})

	it("ignores add-on subscriptions", () => {
		expect(isPastDue(customer({ subs: [sub({ pastDue: true, addOn: true })] }))).toBe(false)
	})

	it("is false when nothing is past_due", () => {
		expect(isPastDue(customer({ subs: [sub({ pastDue: false })] }))).toBe(false)
	})
})

describe("hasNeverPaid", () => {
	it("is true when there are no invoices", () => {
		expect(hasNeverPaid(customer({ subs: [sub({})] }))).toBe(true)
	})

	it("is true when no invoice is paid", () => {
		expect(hasNeverPaid(customer({ subs: [sub({})], invoices: [invoice("open")] }))).toBe(true)
	})

	it("is false once any invoice is paid", () => {
		expect(
			hasNeverPaid(customer({ subs: [sub({})], invoices: [invoice("open"), invoice("paid")] })),
		).toBe(false)
	})
})

describe("shouldSuspend", () => {
	const pastDueNeverPaid = customer({ subs: [sub({ pastDue: true })], invoices: [invoice("open")] })

	it("suspends a never-paid org overdue past the grace window", () => {
		const decision = shouldSuspend({
			customer: pastDueNeverPaid,
			overdueSince: NOW - OVERDUE_GRACE_MS - 1,
			now: NOW,
		})
		expect(decision.suspend).toBe(true)
		expect(decision.overdueInvoiceId).toBe("in_open")
	})

	it("does not suspend before the grace window elapses", () => {
		const decision = shouldSuspend({
			customer: pastDueNeverPaid,
			overdueSince: NOW - 2 * 24 * 60 * 60 * 1000, // 2 days
			now: NOW,
		})
		expect(decision.suspend).toBe(false)
		expect(decision.overdueInvoiceId).toBeNull()
	})

	it("does not suspend an org that has ever paid", () => {
		const decision = shouldSuspend({
			customer: customer({
				subs: [sub({ pastDue: true })],
				invoices: [invoice("open"), invoice("paid")],
			}),
			overdueSince: NOW - OVERDUE_GRACE_MS - 1,
			now: NOW,
		})
		expect(decision.suspend).toBe(false)
	})

	it("does not suspend once the subscription is no longer past_due", () => {
		const decision = shouldSuspend({
			customer: customer({ subs: [sub({ pastDue: false })], invoices: [invoice("open")] }),
			overdueSince: NOW - OVERDUE_GRACE_MS - 1,
			now: NOW,
		})
		expect(decision.suspend).toBe(false)
	})
})
