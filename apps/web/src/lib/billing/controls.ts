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
 * Upsert one feature's overage cap. A disabled entry is deliberate: the billing
 * provider removes a cap only when that feature is explicitly disabled. The
 * usage-alert list is left empty on purpose — a provider usage alert is
 * delivered to Maple's own webhook endpoint, so it is not a control a customer
 * can act on, and an empty list upserts nothing.
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
		usageAlerts: [],
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
