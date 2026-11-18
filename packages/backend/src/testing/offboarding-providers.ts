import { type IntegrationsPersistenceError, type OrgId } from "@maple/domain/http"
import { Effect, Layer } from "effect"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { GoogleOAuthService } from "@maple/backend/services/auth/GoogleOAuthService"
import { LinearOAuthService } from "@maple/backend/services/auth/LinearOAuthService"
import { ChatWorkspaceService } from "@maple/backend/services/integrations/ChatWorkspaceService"
import { PlanetScaleConnectionService } from "@maple/backend/services/integrations/PlanetScaleConnectionService"
import { SupabaseConnectionService } from "@maple/backend/services/integrations/SupabaseConnectionService"
import { VercelIntegrationService } from "@maple/backend/services/integrations/VercelIntegrationService"

/** Every integration `IntegrationOffboardingService` tears down, by the name it reports. */
export const OFFBOARDED_PROVIDERS = [
	"linear",
	"search_console",
	"cloudflare",
	"supabase",
	"vercel",
	"planetscale",
	"chat",
] as const
export type OffboardedProvider = (typeof OFFBOARDED_PROVIDERS)[number]

export interface FakeOffboardingOptions {
	/** Stands in for each integration's vendor teardown; every other method of its service dies. */
	readonly teardown: (
		provider: OffboardedProvider,
		orgId: OrgId,
	) => Effect.Effect<void, IntegrationsPersistenceError>
	/** Integrations whose vendor refuses: the disconnect completes and reports its side not ended. */
	readonly refusedBy?: ReadonlyArray<OffboardedProvider>
}

/** The integration services the offboarding steps call, each answering through `teardown`. */
export const fakeOffboardingProviders = (options: FakeOffboardingOptions) => {
	const ended = (provider: OffboardedProvider) => !(options.refusedBy ?? []).includes(provider)
	const grant = (provider: OffboardedProvider) => (orgId: OrgId) =>
		Effect.as(options.teardown(provider, orgId), { disconnected: true, grantRevoked: ended(provider) })
	return Layer.mergeAll(
		Layer.mock(LinearOAuthService)({ disconnect: grant("linear") }),
		Layer.mock(GoogleOAuthService)({ disconnect: grant("search_console") }),
		Layer.mock(CloudflareOAuthService)({ disconnect: grant("cloudflare") }),
		Layer.mock(SupabaseConnectionService)({
			disconnect: (orgId) =>
				Effect.as(options.teardown("supabase", orgId), {
					disconnected: true,
					drainsRemoved: ended("supabase"),
					grantRevoked: true,
				}),
		}),
		Layer.mock(VercelIntegrationService)({
			disconnect: (orgId) =>
				Effect.as(options.teardown("vercel", orgId), {
					disconnected: true,
					drainsRemoved: ended("vercel"),
				}),
		}),
		Layer.mock(PlanetScaleConnectionService)({
			disconnect: (orgId) =>
				Effect.as(options.teardown("planetscale", orgId), {
					disconnected: true,
					webhooksRemoved: ended("planetscale"),
				}),
		}),
		Layer.mock(ChatWorkspaceService)({
			uninstallAll: (orgId) =>
				Effect.as(options.teardown("chat", orgId), {
					uninstalled: 1,
					revokeFailures: ended("chat") ? 0 : 1,
					unlinkFailures: 0,
				}),
		}),
	)
}
