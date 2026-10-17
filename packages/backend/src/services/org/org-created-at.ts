import type { OrgId } from "@maple/domain/primitives"
import { Effect } from "effect"
import type { OrganizationServiceApi } from "@maple/backend/services/org/OrganizationService"

/**
 * The org's creation time from the identity provider, or null when it cannot be read.
 * Never falls back to "now": an org of unknown age must not open the onboarding reward window.
 */
export const readOrgCreatedAt = (organizations: OrganizationServiceApi, orgId: OrgId) =>
	organizations.retrieve(orgId).pipe(
		Effect.map((org) => org.createdAtMs),
		Effect.catchCause((cause) =>
			Effect.logWarning("Could not read the org's creation time").pipe(
				Effect.annotateLogs({ orgId, cause }),
				Effect.as<number | null>(null),
			),
		),
	)
