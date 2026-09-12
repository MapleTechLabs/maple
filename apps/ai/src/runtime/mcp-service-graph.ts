import { Layer } from "effect"
import { McpToolExecutor } from "../mcp/dispatcher"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"

export const McpServicesLive = McpToolExecutor.layer.pipe(
	Layer.provide(Layer.mergeAll(Env.layer, EdgeCacheServiceLive)),
)

export const InvestigationServicesLive = Layer.mergeAll(
	McpServicesLive,
	InvestigationService.layer.pipe(Layer.provide(Env.layer)),
)
