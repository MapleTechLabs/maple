import type { OrgId } from "@maple/domain/http"
import { Effect } from "effect"
import { clerkRequest } from "@maple/backend/services/auth/clerk-request"
import { type ClerkEnv, clerkModeClient } from "@maple/auth"

/**
 * Resolve a human-friendly org name via Clerk for email headers and subjects.
 * Best-effort: an email must never fail because a name lookup did, so it falls
 * back to the raw orgId on any error or when Clerk isn't configured.
 */
export const resolveOrgName = Effect.fn("Digest.resolveOrgName")(function* (
	env: ClerkEnv & { readonly MAPLE_AUTH_MODE: string },
	orgId: OrgId,
) {
	yield* Effect.annotateCurrentSpan("orgId", orgId)
	const clerk = clerkModeClient(env)
	if (clerk === undefined) return String(orgId)

	return yield* clerkRequest("Clerk.organizations.getOrganization", { orgId }, () =>
		clerk.organizations.getOrganization({ organizationId: orgId }),
	).pipe(
		Effect.map((org) => org.name || String(orgId)),
		Effect.orElseSucceed(() => String(orgId)),
	)
})
