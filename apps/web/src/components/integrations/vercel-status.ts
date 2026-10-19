import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

/** The Vercel connection, shared by the integration card, the catalog, the nav and /infra/vercel. */
export const vercelStatusAtom = retainedInternalQuery("integrations", "vercelStatus", {
	reactivityKeys: ["vercelIntegrationStatus"],
})
