/**
 * The MCP tool executor's service graph, alone. Its own module so the tool path does not
 * evaluate what investigations and chat apply add on top (`./mcp-service-graph`).
 */
import { Layer } from "effect"
import { McpToolExecutor } from "../mcp/dispatcher"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { Database } from "@maple/backend/platform/DatabaseLive"
import type { DataSourcePersistenceError } from "@maple/domain/data-sources"
import {
	ExternalDataSourceService,
	ExternalDataSourceServiceLive,
} from "@maple/backend/services/data-sources/ExternalDataSourceService"

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
		Layer.provide(Layer.mergeAll(Env.layer, EdgeCacheServiceLive)),
	)

export const McpServicesLive = mcpServicesWithFeatureFlags(OrganizationFeatureFlagsService.layer)
