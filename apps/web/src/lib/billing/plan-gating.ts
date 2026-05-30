import { useCustomer } from "autumn-js/react"

type Customer = NonNullable<ReturnType<typeof useCustomer>["data"]>

type Subscription = Customer["subscriptions"][number]

type Balance = NonNullable<Customer["balances"]>[string]

// Metered ingestion features whose usage we surface alerts for. Mirrors the
// Autumn feature ids defined in apps/api/autumn.config.ts.
const METERED_INGEST_FEATURES = ["logs", "traces", "metrics"] as const

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

export function getActivePlan(customer: Customer | null | undefined): Subscription | null {
	if (!customer) return null

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

export function hasBringYourOwnCloudAddOn(customer: Customer | null | undefined): boolean {
	if (!customer) return false

	return !!customer.flags.bringyourowncloud
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
		const level: QuotaLevel =
			ratio >= 1 ? "over" : ratio >= APPROACHING_RATIO ? "approaching" : "ok"
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
