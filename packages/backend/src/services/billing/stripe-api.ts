/**
 * Stripe API version every request pins via `Stripe-Version`.
 *
 * Pinned explicitly rather than inheriting the account default so a Dashboard
 * upgrade can't change the wire shape under us. The customer + tax-ID
 * endpoints this worker uses are unchanged across every version since 2019.
 *
 * Not so the subscription list the cancellation review reads: up to here a
 * discount embeds its `coupon`; `2025-09-30.clover` moves it to
 * `source.coupon`, unexpanded. Past that version `evidence-billing.ts` must read
 * the new place and expand it, or every discount it reports is silently null.
 */
export const STRIPE_API_VERSION = "2025-08-27.basil"
