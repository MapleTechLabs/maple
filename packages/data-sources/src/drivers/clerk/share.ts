/** Maple's share: 5% of Clerk's per-instance limit (1000 and 100 requests per 10 s), so Maple never causes a 429 in the customer's app. */
export const CLERK_CALL_SHARE = {
	production: { limit: 50, period: 10 },
	development: { limit: 5, period: 10 },
} as const
