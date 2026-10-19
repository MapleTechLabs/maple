import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

/** Every write to the Vercel connection invalidates this key; every read of it listens. */
export const VERCEL_STATUS_REACTIVITY_KEY = "vercelIntegrationStatus"

/** The Vercel connection, shared by the integration card, the catalog, the nav and /infra/vercel. */
export const vercelStatusAtom = retainedInternalQuery("integrations", "vercelStatus", {
	reactivityKeys: [VERCEL_STATUS_REACTIVITY_KEY],
})
