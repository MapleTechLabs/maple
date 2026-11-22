/**
 * The MCP tool executor's service graph, alone. Its own module so the tool path does not
 * evaluate what investigations and chat apply add on top (`./mcp-service-graph`).
 */
import { Layer } from "effect"
import { McpToolExecutor } from "../mcp/dispatcher"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { ProductEventsService } from "@maple/backend/services/product-events/ProductEventsService"
import {
	ApnsPrivateKey,
	GithubAppClientSecret,
	GithubAppPrivateKey,
	GithubAppWebhookSecret,
	LinearOAuthClientSecret,
	PlanetScaleOAuthClientSecret,
	ProductEventsIngestKey,
	SandboxInternalServiceToken,
	SearchConsoleClientSecret,
	StatusDomainsApiToken,
	SupabaseOAuthClientSecret,
} from "@maple/infra/secrets"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { Database } from "@maple/backend/platform/DatabaseLive"
import type { DataSourcePersistenceError } from "@maple/domain/data-sources"
import {
	ExternalDataSourceService,
	ExternalDataSourceServiceLive,
} from "@maple/backend/services/data-sources/ExternalDataSourceService"

/** The secrets the tools' services read. Unbound here, a secret reads as absent (`resources/env.ts`). */
const McpToolSecretsLive = Layer.mergeAll(
	ApnsPrivateKey.layer,
	GithubAppClientSecret.layer,
	GithubAppPrivateKey.layer,
	GithubAppWebhookSecret.layer,
	LinearOAuthClientSecret.layer,
	PlanetScaleOAuthClientSecret.layer,
	ProductEventsIngestKey.layer,
	SandboxInternalServiceToken.layer,
	SearchConsoleClientSecret.layer,
	// Status page custom domains (Cloudflare for SaaS); unset, they read as unavailable.
	StatusDomainsApiToken.layer,
	SupabaseOAuthClientSecret.layer,
)

/** What the tools' services need beyond the app root; a test runtime that serves them provides it too. */
export const McpToolPlatformLive = ProductEventsService.layerFor("maple-ai").pipe(
	Layer.provideMerge(Layer.mergeAll(Env.layer, McpToolSecretsLive, EdgeCacheServiceLive)),
)

/**
 * The tool executor over the given org rollout flags and data source service; tests pass a fixed
 * answer and fake drivers.
 */
export const mcpServicesWithFeatureFlags = (
	featureFlags: Layer.Layer<OrganizationFeatureFlagsService, never, Env>,
	dataSources: Layer.Layer<
		ExternalDataSourceService,
		DataSourcePersistenceError,
		Database | Env
	> = ExternalDataSourceServiceLive,
) =>
	McpToolExecutor.layer.pipe(
		Layer.provide(dataSources),
		Layer.provide(featureFlags),
		Layer.provide(McpToolPlatformLive),
	)

export const McpServicesLive = mcpServicesWithFeatureFlags(OrganizationFeatureFlagsService.layer)
