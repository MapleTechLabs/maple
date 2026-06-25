import { useMemo } from "react"
import { useMapleCustomer } from "@/hooks/use-maple-customer"
import { getActivePlan, isLegacyPlan } from "@/lib/billing/plan-gating"

export function useTrialStatus() {
	const { data: customer, isLoading } = useMapleCustomer()

	return useMemo(() => {
		const sub = getActivePlan(customer)

		if (!sub) {
			return {
				isTrialing: false,
				daysRemaining: null,
				trialEndsAt: null,
				planName: null,
				planId: null,
				planStatus: null,
				isLegacy: false,
				isLoading,
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
			isLegacy: isLegacyPlan(sub),
			isLoading,
		}
	}, [customer, isLoading])
}
