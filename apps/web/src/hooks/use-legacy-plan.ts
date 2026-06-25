import { useMemo } from "react"
import { useListPlans } from "autumn-js/react"
import { useMapleCustomer } from "@/hooks/use-maple-customer"
import { getLegacyPlanInfo } from "@/lib/billing/plan-gating"

/**
 * Whether the org's active plan is legacy/grandfathered (no longer in the live
 * `listPlans` catalog), plus its display name. `getOrCreateCustomer` doesn't
 * expand the subscription's plan, so legacy detection compares the active planId
 * against the current catalog — hence both `useCustomer` and `useListPlans`.
 */
export function useLegacyPlan() {
	const { data: customer } = useMapleCustomer()
	const { data: plans } = useListPlans()
	return useMemo(() => getLegacyPlanInfo(customer, plans), [customer, plans])
}
