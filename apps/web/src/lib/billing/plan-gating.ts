import type {
	BillingBalance,
	BillingCustomer,
	BillingSubscription,
	CatalogPlan,
} from "@maple/domain/http"
import type { AggregatedUsage } from "./usage"

type Customer = BillingCustomer

type Subscription = BillingSubscription

type Balance = BillingBalance

// A plan from the live `listPlans` catalog — the source of truth for which plans
// are currently offered and for per-feature overage rates. `getOrCreateCustomer`
// does NOT expand `subscription.plan`, so neither legacy detection nor overage
// rates can rely on it; both read the catalog instead.
export type { CatalogPlan }

// Metered ingestion features whose usage we surface alerts for. Mirrors the
// Autumn feature ids defined in apps/api/autumn.config.ts.
const METERED_INGEST_FEATURES = ["logs", "traces", "metrics"] as const

// Metered features we surface overage costs for — the ingest trio plus browser
// sessions, all of which carry usage-based pricing on the Startup plan.
const OVERAGE_FEATURES = ["logs", "traces", "metrics", "browser_sessions"] as const

// Surface a warning once usage crosses 80% of the included grant; "over" once it
// reaches 100%. Mirrors the meter thresholds in usage-meters.tsx.
const APPROACHING_RATIO = 0.8

export type QuotaLevel = "ok" | "approaching" | "over"

export interface FeatureQuota {
	featureId: string
	usage: number
	granted: number
	ratio: number
	level: QuotaLevel
}

function isLegacyFreePlan(sub: Subscription): boolean {
	if (sub.planId.toLowerCase() === "free") return true
	return sub.plan?.name?.toLowerCase() === "free"
}

// A subscription is "legacy" when its plan is no longer offered to new customers:
// it's the old free tier, or its planId isn't in the current `listPlans` catalog,
// or it maps to a catalog plan flagged archived. We only fall back to the
// catalog-membership check once the catalog has loaded — an empty/missing catalog
// means "unknown", not "legacy", so the badge never flickers on during load.
export function isLegacyPlan(
	sub: Subscription,
	plans: ReadonlyArray<CatalogPlan> | null | undefined,
): boolean {
	if (isLegacyFreePlan(sub)) return true
	if (sub.plan?.archived === true) return true
	if (!plans || plans.length === 0) return false
	const catalogPlan = plans.find((plan) => plan.id === sub.planId)
	if (!catalogPlan) return true
	return catalogPlan.archived === true
}

// Autumn's `useCustomer` surfaces upstream API failures (e.g. a `200` whose
// body is an `autumn_api_error` from a failed response validation) as `data`
// rather than `error`. Those payloads have no `subscriptions`/`balances`, so a
// blind `customer.subscriptions.find(...)` would throw and take down every
// route. Treat anything without a `subscriptions` array as "no usable customer"
// and let callers fail open instead of crashing.
export function isUsableCustomer(customer: Customer | null | undefined): customer is Customer {
	return !!customer && Array.isArray(customer.subscriptions)
}

export function getActivePlan(customer: Customer | null | undefined): Subscription | null {
	if (!isUsableCustomer(customer)) return null

	return (
		customer.subscriptions.find((sub) => {
			if (sub.addOn || sub.autoEnable) return false
			if (isLegacyFreePlan(sub)) return false
			return sub.status === "active"
		}) ?? null
	)
}

export function hasSelectedPlan(customer: Customer | null | undefined): boolean {
	return getActivePlan(customer) !== null
}

export interface TrialStatus {
	isTrialing: boolean
	daysRemaining: number | null
	trialEndsAt: Date | null
	planName: string | null
	planId: string | null
	planStatus: string | null
}

// Trial standing for the org's active plan, derived purely from the customer.
// `isTrialing` when the active sub carries a future `trialEndsAt`. Drives the
// billing subscription strip and the pricing cards' trial badges.
export function getTrialStatus(customer: Customer | null | undefined): TrialStatus {
	const sub = getActivePlan(customer)
	if (!sub) {
		return {
			isTrialing: false,
			daysRemaining: null,
			trialEndsAt: null,
			planName: null,
			planId: null,
			planStatus: null,
		}
	}

	const isTrialing = sub.trialEndsAt != null && sub.trialEndsAt > Date.now()
	let daysRemaining: number | null = null
	let trialEndsAt: Date | null = null

	if (isTrialing && sub.trialEndsAt) {
		trialEndsAt = new Date(sub.trialEndsAt)
		const msRemaining = trialEndsAt.getTime() - Date.now()
		daysRemaining = msRemaining > 0 ? Math.ceil(msRemaining / (1000 * 60 * 60 * 24)) : 0
	}

	return {
		isTrialing,
		daysRemaining,
		trialEndsAt,
		planName: sub.plan?.name ?? sub.planId,
		planId: sub.planId,
		planStatus: sub.status,
	}
}

export function hasBringYourOwnCloudAddOn(customer: Customer | null | undefined): boolean {
	if (!customer) return false

	return !!customer.flags?.bringyourowncloud
}

// A balance is "hard-capped" when it has a finite grant and bills no overage —
// i.e. a base-plan feature with a fixed included amount. Unlimited or
// overage-allowed (usage-based) features are never hard-capped.
function isHardCapped(balance: Balance | undefined): balance is Balance {
	if (!balance) return false
	if (balance.unlimited || balance.overageAllowed) return false
	return (balance.granted ?? 0) > 0
}

// True when any metered ingest feature bills usage-based overage. Such orgs have
// no fixed cap, so they should never see a usage-limit alert.
export function isUsageBasedPlan(customer: Customer | null | undefined): boolean {
	const balances = customer?.balances
	if (!balances) return false
	return METERED_INGEST_FEATURES.some((featureId) => balances[featureId]?.overageAllowed === true)
}

// Per-feature quota standing for the hard-capped (base-plan) ingest features.
// Features that are unlimited, usage-based, or un-granted are omitted.
export function getFeatureQuotas(customer: Customer | null | undefined): FeatureQuota[] {
	const balances = customer?.balances
	if (!balances) return []

	const quotas: FeatureQuota[] = []
	for (const featureId of METERED_INGEST_FEATURES) {
		const balance = balances[featureId]
		if (!isHardCapped(balance)) continue

		const granted = balance.granted ?? 0
		const usage = balance.usage ?? 0
		const ratio = granted > 0 ? usage / granted : 0
		const level: QuotaLevel = ratio >= 1 ? "over" : ratio >= APPROACHING_RATIO ? "approaching" : "ok"
		quotas.push({ featureId, usage, granted, ratio, level })
	}
	return quotas
}

// Worst-case quota standing across a base-plan org's hard-capped ingest
// features. "over" means at/over the included limit; "approaching" means within
// 80–100%. Purely informational (drives the in-app usage alert) — nothing is
// blocked. Usage-based and unlimited orgs always resolve to "ok".
export function getQuotaStatus(customer: Customer | null | undefined): QuotaLevel {
	const quotas = getFeatureQuotas(customer)
	if (quotas.some((quota) => quota.level === "over")) return "over"
	if (quotas.some((quota) => quota.level === "approaching")) return "approaching"
	return "ok"
}

// The first non-add-on subscription with overdue payments, or null. Not gated on
// `status === "active"` — a past-due sub may carry any status, and we always want
// to surface it.
export function getPastDueSubscription(customer: Customer | null | undefined): Subscription | null {
	if (!isUsableCustomer(customer)) return null
	return customer.subscriptions.find((sub) => !sub.addOn && sub.pastDue === true) ?? null
}

// Whether the org's active plan is a legacy/grandfathered one, plus its display
// name (for the billing badge). Mirrors the plan shown in the subscription strip.
export function getLegacyPlanInfo(
	customer: Customer | null | undefined,
	plans: ReadonlyArray<CatalogPlan> | null | undefined,
): {
	isLegacy: boolean
	planName: string | null
} {
	const sub = getActivePlan(customer)
	if (!sub) return { isLegacy: false, planName: null }
	return { isLegacy: isLegacyPlan(sub, plans), planName: sub.plan?.name ?? sub.planId }
}

export interface FeatureOverage {
	featureId: string
	usage: number
	granted: number
	overageUnits: number
	/** Price per billing unit (e.g. $/GB or $/session), read live from the plan. */
	rate: number
	cost: number
}

export interface OverageSummary {
	features: FeatureOverage[]
	total: number
	hasOverage: boolean
}

// Maps an Autumn featureId to the usage value already aggregated for the meters,
// so the overage breakdown agrees exactly with what the meters display.
function usageForFeature(featureId: string, usage: AggregatedUsage): number {
	switch (featureId) {
		case "logs":
			return usage.logsGB
		case "traces":
			return usage.tracesGB
		case "metrics":
			return usage.metricsGB
		case "browser_sessions":
			return usage.browserSessions
		default:
			return 0
	}
}

// Per-unit overage price for a feature, read from the catalog plan's items. Null
// when the feature isn't priced or uses tiered (amount-less) pricing.
function overageRateForFeature(catalogPlan: CatalogPlan | undefined, featureId: string): number | null {
	const price = catalogPlan?.items?.find((item) => item.featureId === featureId)?.price
	if (!price || price.amount == null) return null
	const units = price.billingUnits || 1
	return price.amount / units
}

// Estimated overage charges accruing this period: for each usage-based metered
// feature whose usage exceeds the included grant, `(usage − granted) × rate`.
// Rates come live from the `listPlans` catalog (no hardcoded prices), matched to
// the org's active planId. Empty when nothing is over or the org isn't on a
// usage-based plan in the current catalog.
export function getOverageSummary(
	customer: Customer | null | undefined,
	usage: AggregatedUsage,
	plans: ReadonlyArray<CatalogPlan> | null | undefined,
): OverageSummary {
	const balances = customer?.balances
	const activeSub = getActivePlan(customer)
	const catalogPlan = activeSub ? plans?.find((plan) => plan.id === activeSub.planId) : undefined
	const features: FeatureOverage[] = []

	if (balances && catalogPlan) {
		for (const featureId of OVERAGE_FEATURES) {
			const balance = balances[featureId]
			if (!balance?.overageAllowed) continue

			// A feature with no finite grant (null/unlimited) has no included
			// threshold to exceed, so its usage isn't overage. Without this guard a
			// `granted: null` balance would collapse to `granted = 0` below and bill
			// the entire metered usage as overage.
			if (balance.granted == null || balance.unlimited) continue

			const rate = overageRateForFeature(catalogPlan, featureId)
			if (rate == null) continue

			const granted = balance.granted
			const used = usageForFeature(featureId, usage)
			const overageUnits = used - granted
			if (overageUnits <= 0) continue

			features.push({ featureId, usage: used, granted, overageUnits, rate, cost: overageUnits * rate })
		}
	}

	const total = features.reduce((sum, feature) => sum + feature.cost, 0)
	return { features, total, hasOverage: features.length > 0 }
}
