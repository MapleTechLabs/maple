import { makeResolveTenant } from "@maple/auth"
import type {
	AuthorizationUnavailableError,
	OrganizationAccessDeniedError,
	UnauthorizedError,
	TenantContext,
} from "@maple/domain/http"
import { Context, Effect, Layer } from "effect"
import { SyncConfig } from "../config"

export interface TenantResolverApi {
	readonly resolve: (
		headers: Record<string, string | undefined>,
	) => Effect.Effect<
		TenantContext,
		UnauthorizedError | OrganizationAccessDeniedError | AuthorizationUnavailableError
	>
}

/**
 * `makeResolveTenant` as a service, so router tests can pin a fixed tenant (a test cannot mint a
 * Clerk session). No API-key path: this worker has no database and shape fetches send only the
 * session bearer.
 *
 * No membership verifier either, so `x-maple-org-id` is REJECTED rather than ignored: an ignored
 * selection would serve the token's own rows under another organization's name.
 */
export class TenantResolver extends Context.Service<TenantResolver, TenantResolverApi>()(
	"@maple/electric-sync/TenantResolver",
	{
		make: Effect.gen(function* () {
			const config = yield* SyncConfig
			return { resolve: makeResolveTenant(config) } satisfies TenantResolverApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
