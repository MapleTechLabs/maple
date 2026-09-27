import { createClerkClient } from "@clerk/backend"
import type { OrgId } from "@maple/domain/http"
import { Effect, Option, Redacted } from "effect"
import { clerkRequest } from "@maple/backend/services/auth/clerk-request"

/**
 * Resolve a human-friendly org name via Clerk for email headers and subjects.
 * Best-effort: an email must never fail because a name lookup did, so it falls
 * back to the raw orgId on any error or when Clerk isn't configured.
 */
export const resolveOrgName = Effect.fn("resolveOrgName")(function* (
	env: {
		readonly MAPLE_AUTH_MODE: string
		readonly CLERK_SECRET_KEY: Option.Option<Redacted.Redacted<string>>
	},
	orgId: OrgId,
) {
	yield* Effect.annotateCurrentSpan("orgId", orgId)
	if (env.MAPLE_AUTH_MODE.toLowerCase() !== "clerk") return String(orgId)
	if (Option.isNone(env.CLERK_SECRET_KEY)) return String(orgId)

	const clerk = createClerkClient({ secretKey: Redacted.value(env.CLERK_SECRET_KEY.value) })

	return yield* clerkRequest("Clerk.organizations.getOrganization", { orgId }, () =>
		clerk.organizations.getOrganization({ organizationId: orgId }),
	).pipe(
		Effect.map((org) => org.name || String(orgId)),
		Effect.orElseSucceed(() => String(orgId)),
	)
})
