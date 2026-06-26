import type { BillingCustomer } from "@maple/domain/http"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { billingCustomerAtom } from "@/lib/services/atoms/billing-atoms"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"

type UseMapleCustomerOptions = {
	queryOptions?: { enabled?: boolean }
}

/**
 * Thin accessor over `billingCustomerAtom` for the incidental consumers (app
 * shell, banners, nav, onboarding) that just need `{ data, isLoading, error }`.
 * The billing page components read the atom directly via `Result.builder`.
 *
 * `enabled: false` (used by `__root` before an org is active) swaps in a disabled
 * atom so the customer fetch never fires for signed-out / org-less sessions.
 */
export function useMapleCustomer(options?: UseMapleCustomerOptions) {
	const enabled = options?.queryOptions?.enabled ?? true
	const result = useAtomValue(enabled ? billingCustomerAtom : disabledResultAtom<BillingCustomer>())

	return {
		data: Result.isSuccess(result) ? result.value : undefined,
		isLoading: Result.isInitial(result),
		error: Result.builder(result)
			.onError((cause) => cause)
			.orElse(() => undefined),
	}
}
