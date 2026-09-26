import type { BillingCustomer, BillingSpendLimit } from "@maple/domain/http"
import {
	UpdateBillingControlsRequest,
	UpdateBillingSpendLimit as UpdateBillingSpendLimitClass,
} from "@maple/domain/http"

import type { SpendFeatureId, SpendModel } from "./spend"

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

/** Maximum invoice when every paid feature has a cap; null means unbounded. */
export const maximumInvoiceCents = (
	model: SpendModel | null,
	customer: BillingCustomer | undefined,
): number | null => {
	if (model === null || model.partial) return null
	let maximum = model.baseCents
	for (const feature of model.features) {
		if (feature.unlimited || feature.ratePerUnit === null || feature.overageAllowed === false) continue
		const limit = spendLimitFor(customer, feature.featureId)?.overageLimit
		if (limit === undefined) return null
		maximum += Math.round(limit * feature.ratePerUnit * 100)
	}
	return maximum
}
