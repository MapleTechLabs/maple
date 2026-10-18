import type { BillingCustomer, BillingSpendLimit } from "@maple/domain/http"
import {
	UpdateBillingControlsRequest,
	UpdateBillingSpendLimit as UpdateBillingSpendLimitClass,
} from "@maple/domain/http"

import type { FeatureSpend, SpendFeatureId, SpendModel } from "./spend"

export const spendLimitFor = (
	customer: BillingCustomer | undefined,
	featureId: SpendFeatureId,
): BillingSpendLimit | undefined =>
	customer?.billingControls?.spendLimits?.find((limit) => limit.featureId === featureId && limit.enabled)

/**
 * Upsert one feature's overage cap; the API merges it over the other features'
 * caps. A disabled entry removes the cap. Usage alerts are omitted so the ones
 * an org already has are left untouched.
 */
export const updateFeatureControls = ({
	featureId,
	overageLimit,
}: {
	readonly featureId: SpendFeatureId
	readonly overageLimit: number | null
}): UpdateBillingControlsRequest =>
	new UpdateBillingControlsRequest({
		spendLimits: [
			new UpdateBillingSpendLimitClass({
				featureId,
				enabled: overageLimit !== null,
				...(!(overageLimit === null) ? { limitType: "absolute" as const, overageLimit } : undefined),
			}),
		],
	})

/** Can a cap bound this feature's bill? Not when it is unlimited, hard-capped or has no known rate. */
export const capApplies = (feature: FeatureSpend): boolean =>
	!feature.unlimited && feature.ratePerUnit !== null && feature.overageAllowed !== false

/** Features that bill overage with no cap; any one of them leaves the maximum invoice unbounded. */
export const uncappedFeatures = (
	model: SpendModel,
	customer: BillingCustomer | undefined,
): ReadonlyArray<FeatureSpend> =>
	model.features.filter(
		(feature) =>
			capApplies(feature) && spendLimitFor(customer, feature.featureId)?.overageLimit === undefined,
	)

/** Maximum invoice when every paid feature has a cap; null means unbounded. */
export const maximumInvoiceCents = (
	model: SpendModel | null,
	customer: BillingCustomer | undefined,
): number | null => {
	if (model === null || model.partial) return null
	if (uncappedFeatures(model, customer).length > 0) return null
	return model.features.reduce((maximum, feature) => {
		const limit = spendLimitFor(customer, feature.featureId)?.overageLimit
		if (!capApplies(feature) || limit === undefined || feature.ratePerUnit === null) return maximum
		return maximum + Math.round(limit * feature.ratePerUnit * 100)
	}, model.baseCents)
}

export type CapInput = { readonly valid: true; readonly cap: number | null } | { readonly valid: false }

/** Plain decimals only: `Number()` alone would accept "1e3", "0x10" and "Infinity". */
const DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/

/** A typed cap: empty removes the cap, zero or more sets it, anything else is invalid. */
export const parseCapInput = (raw: string): CapInput => {
	const trimmed = raw.trim()
	if (trimmed === "") return { valid: true, cap: null }
	return DECIMAL.test(trimmed) ? { valid: true, cap: Number(trimmed) } : { valid: false }
}
