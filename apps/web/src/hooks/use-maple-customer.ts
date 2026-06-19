import { useCustomer } from "autumn-js/react"

type UseCustomerParams = Parameters<typeof useCustomer>[0]

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
			...params?.queryOptions,
		},
	})
}
