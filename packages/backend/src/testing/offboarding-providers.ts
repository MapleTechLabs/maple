import { type IntegrationsPersistenceError, type OrgId } from "@maple/domain/http"
import { Effect, Layer } from "effect"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { GoogleOAuthService } from "@maple/backend/services/auth/GoogleOAuthService"
import { LinearOAuthService } from "@maple/backend/services/auth/LinearOAuthService"
import { ChatWorkspaceService } from "@maple/backend/services/integrations/ChatWorkspaceService"
import { PlanetScaleConnectionService } from "@maple/backend/services/integrations/PlanetScaleConnectionService"
import { SupabaseConnectionService } from "@maple/backend/services/integrations/SupabaseConnectionService"
import { VercelIntegrationService } from "@maple/backend/services/integrations/VercelIntegrationService"
import { VcsInstallationRemovalService } from "@maple/backend/services/integrations/vcs/VcsInstallationRemovalService"

/** Every integration `IntegrationOffboardingService` tears down, by the name it reports. */
export const OFFBOARDED_PROVIDERS = [
	"linear",
	"search_console",
	"cloudflare",
	"supabase",
	"vercel",
	"planetscale",
	"github",
	"chat",
] as const
export type OffboardedProvider = (typeof OFFBOARDED_PROVIDERS)[number]

export interface FakeOffboardingOptions {
	/** Stands in for each integration's vendor teardown; every other method of its service dies. */
	readonly teardown: (
		provider: OffboardedProvider,
		orgId: OrgId,
	) => Effect.Effect<void, IntegrationsPersistenceError>
	/** What Vercel reports about its drains; true unless a test says they stayed. */
	readonly vercelDrainsRemoved?: boolean
}

/** The integration services the offboarding steps call, each answering through `teardown`. */
export const fakeOffboardingProviders = (options: FakeOffboardingOptions) => {
	const run = (provider: OffboardedProvider) => (orgId: OrgId) =>
		Effect.as(options.teardown(provider, orgId), { disconnected: true })
	return Layer.mergeAll(
		Layer.mock(LinearOAuthService)({ disconnect: run("linear") }),
		Layer.mock(GoogleOAuthService)({ disconnect: run("search_console") }),
		Layer.mock(CloudflareOAuthService)({ disconnect: run("cloudflare") }),
		Layer.mock(SupabaseConnectionService)({ disconnect: run("supabase") }),
		Layer.mock(VercelIntegrationService)({
			disconnect: (orgId) =>
				Effect.as(options.teardown("vercel", orgId), {
					disconnected: true,
					drainsRemoved: options.vercelDrainsRemoved ?? true,
				}),
		}),
		Layer.mock(PlanetScaleConnectionService)({ disconnect: run("planetscale") }),
		Layer.mock(VcsInstallationRemovalService)({
			uninstallForDeletedOrganization: (orgId) =>
				Effect.as(options.teardown("github", orgId), { uninstalled: 1 }),
		}),
		Layer.mock(ChatWorkspaceService)({
			uninstallAll: (orgId) => Effect.as(options.teardown("chat", orgId), { uninstalled: 1 }),
		}),
	)
}
