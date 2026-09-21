import { Layer } from "effect"
import { McpToolExecutor } from "../mcp/dispatcher"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"
import { PrReviewService } from "@maple/backend/services/pr-review/PrReviewService"

export const McpServicesLive = McpToolExecutor.layer.pipe(
	Layer.provide(Layer.mergeAll(Env.layer, EdgeCacheServiceLive)),
)

/** What a chat turn's runtime needs beyond the tools: the two completion tools' services. */
export const InvestigationServicesLive = Layer.mergeAll(
	McpServicesLive,
	InvestigationService.layer.pipe(Layer.provide(Env.layer)),
	PrReviewService.layer.pipe(Layer.provide(Env.layer)),
)
