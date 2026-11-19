import type { OrgId } from "@maple/domain/http"
import * as Clerk from "@distilled.cloud/clerk"
import { Effect } from "effect"
import { type AuthEnv, clerkModeApi } from "@maple/auth"

/**
 * Resolve a human-friendly org name via Clerk for email headers and subjects.
 * Best-effort: an email must never fail because a name lookup did, so it falls
 * back to the raw orgId on any error or when Clerk isn't configured.
 */
export const resolveOrgName = Effect.fn("Digest.resolveOrgName")(function* (
	env: Pick<AuthEnv, "CLERK_SECRET_KEY" | "MAPLE_AUTH_MODE">,
	orgId: OrgId,
) {
	yield* Effect.annotateCurrentSpan("orgId", orgId)
	const api = clerkModeApi(env)
	if (api === undefined) return String(orgId)

	return yield* api.run(Clerk.getOrganization({ organization_id: orgId })).pipe(
		Effect.map((org) => org.name || String(orgId)),
		Effect.orElseSucceed(() => String(orgId)),
	)
})
