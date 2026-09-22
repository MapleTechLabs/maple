/**
 * An organization's rollout flags, as the server sees them.
 *
 * The same contract the web app reads (`@maple/domain/organization-feature-flags`), decoded from
 * the same Clerk public metadata, so "flagged on" means one thing on both sides. The web app uses
 * the flags to decide what to show; a server consumer uses them to decide what to run, which is
 * what keeps a merged-but-staged feature from acting for an organization that never saw it.
 *
 * Self-hosted builds have no Clerk to read and get every rollout on, as the web app does. A
 * managed build that cannot reach Clerk fails closed: every rollout off for that call.
 */
import { createClerkClient } from "@clerk/backend"
import {
	DISABLED_ORGANIZATION_FEATURE_FLAGS,
	ENABLED_ORGANIZATION_FEATURE_FLAGS,
	type OrganizationFeatureFlags,
	organizationFeatureFlagsFrom,
} from "@maple/domain/organization-feature-flags"
import type { OrgId } from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Option, Redacted } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { clerkRequest } from "@maple/backend/services/auth/clerk-request"

/**
 * How long one organization's flags are reused within an isolate. Short enough that withdrawing a
 * flag takes effect within a minute; long enough that a burst of pushes is one Clerk call.
 */
const FLAGS_TTL_MS = 60_000

export interface OrganizationFeatureFlagsServiceApi {
	/** Never fails: an unreadable organization is an organization with every rollout off. */
	readonly flags: (orgId: OrgId) => Effect.Effect<OrganizationFeatureFlags>
}

export class OrganizationFeatureFlagsService extends Context.Service<
	OrganizationFeatureFlagsService,
	OrganizationFeatureFlagsServiceApi
>()("@maple/backend/services/org/OrganizationFeatureFlagsService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const clerkMode = env.MAPLE_AUTH_MODE.toLowerCase() === "clerk"
		const clerk = Option.match(env.CLERK_SECRET_KEY, {
			onNone: () => undefined,
			onSome: (secretKey) => createClerkClient({ secretKey: Redacted.value(secretKey) }),
		})

		const cache = new Map<OrgId, { readonly flags: OrganizationFeatureFlags; readonly atMs: number }>()

		const read = Effect.fn("OrganizationFeatureFlagsService.read")(function* (orgId: OrgId) {
			if (clerk === undefined) {
				yield* Effect.annotateCurrentSpan("maple.feature_flags.source", "no_clerk_secret")
				return DISABLED_ORGANIZATION_FEATURE_FLAGS
			}
			return yield* clerkRequest("Clerk.organizations.getOrganization", { orgId }, () =>
				clerk.organizations.getOrganization({ organizationId: orgId }),
			).pipe(
				Effect.map((organization) => organizationFeatureFlagsFrom(organization.publicMetadata)),
				Effect.catch((error) =>
					Effect.logWarning(
						"Could not read organization feature flags; treating every rollout as off",
					).pipe(
						Effect.annotateLogs({ orgId, error: error.message }),
						Effect.as(DISABLED_ORGANIZATION_FEATURE_FLAGS),
					),
				),
			)
		})

		const flags: OrganizationFeatureFlagsServiceApi["flags"] = Effect.fn(
			"OrganizationFeatureFlagsService.flags",
		)(function* (orgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			if (!clerkMode) return ENABLED_ORGANIZATION_FEATURE_FLAGS
			const nowMs = yield* Clock.currentTimeMillis
			const cached = cache.get(orgId)
			if (cached !== undefined && nowMs - cached.atMs < FLAGS_TTL_MS) {
				yield* Effect.annotateCurrentSpan("maple.feature_flags.source", "cache")
				return cached.flags
			}
			const fresh = yield* read(orgId)
			cache.set(orgId, { flags: fresh, atMs: nowMs })
			return fresh
		})

		return { flags } satisfies OrganizationFeatureFlagsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)

	/** Every rollout on, for tests and for callers that are gated elsewhere. */
	static readonly allEnabled = Layer.succeed(this, {
		flags: () => Effect.succeed(ENABLED_ORGANIZATION_FEATURE_FLAGS),
	})

	/** A fixed answer, for tests. */
	static readonly fixed = (value: OrganizationFeatureFlags) =>
		Layer.succeed(this, { flags: () => Effect.succeed(value) })
}
