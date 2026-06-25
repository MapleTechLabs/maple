import { useCustomer } from "autumn-js/react"
import { hasSelectedPlan } from "@/lib/billing/plan-gating"

type UseCustomerParams = Parameters<typeof useCustomer>[0]

// Settled on a plan: cache 5 min (matches the API edge cache; off the hot path).
const SETTLED_STALE_MS = 1000 * 60 * 5
// No plan yet (onboarding / post-checkout sync window): stay stale and poll so
// the gate releases a just-subscribed user fast. Auto-stops once a plan is active.
const UNSETTLED_POLL_MS = 1000 * 5

// Autumn's `AutumnProvider` builds its own internal QueryClient with
// `retry: false` hard-coded (and bundles its own @tanstack/react-query, so a
// QueryClient we mount higher in the tree is invisible to its hooks). That means
// a single transient 401 — the Clerk token is still settling right after
// sign-in / org creation, so the fetch interceptor sends getOrCreateCustomer
// unauthenticated — sticks for the whole 60s stale window and the customer/plan
// never loads. There is no supported way to inject a QueryClient, so we apply
// the retry per-hook here, in one place, mirroring the `useListPlans` fix in
// pricing-cards. Fast/bounded (~250/500/1000ms): the gap is sub-second and this
// query is on the whole-app hot path, so we don't want a long backoff blanking
// the screen.
export function useMapleCustomer(params?: UseCustomerParams) {
	return useCustomer({
		...params,
		queryOptions: {
			retry: 3,
			retryDelay: (attempt: number) => Math.min(250 * 2 ** attempt, 1000),
			// Long cache once settled on a plan; stale + polling while planless.
			staleTime: (query) =>
				hasSelectedPlan(query.state.data) ? SETTLED_STALE_MS : UNSETTLED_POLL_MS,
			refetchInterval: (query) => (hasSelectedPlan(query.state.data) ? false : UNSETTLED_POLL_MS),
			...params?.queryOptions,
		},
	})
}
