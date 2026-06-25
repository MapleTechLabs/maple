/**
 * Shared billing gate — the single source of truth for "is this an actively
 * selected paid plan?", used by both the web redirect gate
 * (apps/web/src/lib/billing/plan-gating.ts) and the API customer-cache TTL
 * (apps/api/src/routes/autumn.http.ts) so the two can't drift. Structurally
 * typed so `autumn-js` stays out of `@maple/domain`; Autumn's `Subscription`
 * shape satisfies it.
 */
export interface PlanGatingSubscription {
	readonly status?: string | null
	readonly addOn?: boolean | null
	readonly autoEnable?: boolean | null
	readonly planId?: string | null
	readonly plan?: { readonly name?: string | null } | null
}

/** Active, and not an add-on / auto-enabled / legacy-free tier. Trials count — Autumn reports them as `active`. */
export function isActivePlanSubscription(sub: PlanGatingSubscription | null | undefined): boolean {
	if (!sub) return false
	if (sub.addOn || sub.autoEnable) return false
	if (sub.planId?.toLowerCase() === "free" || sub.plan?.name?.toLowerCase() === "free") return false
	return sub.status === "active"
}
