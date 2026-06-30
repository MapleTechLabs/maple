import type { BillingCustomer } from "@maple/domain/http"

// Pure decision logic for the "stop ingestion once 3 days overdue and never
// paid" policy. Kept free of Effect/DB so it can be unit-tested directly.

// The overdue grace window: an org must be past_due for at least this long
// before ingestion is suspended.
export const OVERDUE_GRACE_MS = 3 * 24 * 60 * 60 * 1000

// Invoice statuses that count as "still owed" (an unpaid, finalized invoice).
const UNPAID_INVOICE_STATUSES: ReadonlySet<string> = new Set(["open", "uncollectible", "past_due"])

// A non-add-on subscription currently flagged past_due by Autumn. `pastDue` is
// Autumn's canonical overdue signal — we don't reconstruct it from raw invoices.
export const isPastDue = (customer: BillingCustomer): boolean =>
	customer.subscriptions.some((sub) => sub.addOn !== true && sub.pastDue === true)

// "Never paid" = no settled invoice on record. Requires the customer to have
// been fetched with `expand: ["invoices"]`; an absent/empty invoices array means
// no paid invoice exists, which is exactly the never-converted signup we target.
export const hasNeverPaid = (customer: BillingCustomer): boolean => {
	const invoices = customer.invoices ?? []
	return !invoices.some((invoice) => invoice.status === "paid")
}

// The Stripe id of the first still-owed invoice, for audit on the suspension row.
export const firstUnpaidInvoiceId = (customer: BillingCustomer): string | null => {
	const invoices = customer.invoices ?? []
	const owed = invoices.find(
		(invoice) => typeof invoice.status === "string" && UNPAID_INVOICE_STATUSES.has(invoice.status),
	)
	return owed?.stripeId ?? null
}

export interface SuspendDecision {
	readonly suspend: boolean
	readonly overdueInvoiceId: string | null
}

// Should an already-overdue org be promoted to suspended? True only when it is
// still past_due, has never paid, and has been overdue for >= the grace window.
// `overdueSince` / `now` are epoch ms.
export const shouldSuspend = (input: {
	readonly customer: BillingCustomer
	readonly overdueSince: number
	readonly now: number
	readonly graceMs?: number
}): SuspendDecision => {
	const graceMs = input.graceMs ?? OVERDUE_GRACE_MS
	const elapsed = input.now - input.overdueSince
	const suspend =
		isPastDue(input.customer) && hasNeverPaid(input.customer) && elapsed >= graceMs
	return {
		suspend,
		overdueInvoiceId: suspend ? firstUnpaidInvoiceId(input.customer) : null,
	}
}
