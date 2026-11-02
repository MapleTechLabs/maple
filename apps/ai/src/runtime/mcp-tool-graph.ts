/**
 * The MCP tool executor's service graph, alone. Its own module so the tool path does not
 * evaluate what investigations and chat apply add on top (`./mcp-service-graph`).
 */
import { Layer } from "effect"
import { McpToolExecutor } from "../mcp/dispatcher"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"

/** The tool executor over the given org rollout flags; tests pass a fixed answer. */
export const mcpServicesWithFeatureFlags = (
	featureFlags: Layer.Layer<OrganizationFeatureFlagsService, never, Env>,
) =>
	McpToolExecutor.layer.pipe(
		Layer.provide(featureFlags),
		Layer.provide(Layer.mergeAll(Env.layer, EdgeCacheServiceLive)),
	)

export const McpServicesLive = mcpServicesWithFeatureFlags(OrganizationFeatureFlagsService.layer)
