import { Layer } from "effect"
import { McpToolExecutor } from "../mcp/dispatcher"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"

export const McpServicesLive = McpToolExecutor.layer.pipe(
	Layer.provide(Layer.mergeAll(Env.layer, EdgeCacheServiceLive)),
)

export const InvestigationServicesLive = Layer.mergeAll(
	McpServicesLive,
	// The turn resolves its own actor before the run: a connector turn acts as the connector's
	// agent, which the toolkit and the audit log both read off the tenant.
	ErrorActorsService.layer,
	InvestigationService.layer.pipe(Layer.provide(Env.layer)),
)
