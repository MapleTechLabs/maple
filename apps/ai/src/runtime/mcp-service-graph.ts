import { Layer } from "effect"
import { McpToolExecutor } from "../mcp/dispatcher"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { OrgMembershipService } from "@maple/backend/services/auth/OrgMembershipService"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"
import { OrgOpenRouterKeyService } from "@maple/backend/services/org/OrgOpenRouterKeyService"
import { PrReviewService } from "@maple/backend/services/pr-review/PrReviewService"
import { PrReviewConversationService } from "@maple/backend/services/pr-review/PrReviewConversationService"

export const McpServicesLive = McpToolExecutor.layer.pipe(
	Layer.provide(Layer.mergeAll(Env.layer, EdgeCacheServiceLive)),
)

/**
 * What applying a proposal somebody approved from a chat platform needs, and nothing else.
 *
 * Its own export rather than three lines at the call site: the two services beyond the executor
 * are both there to answer "who is this change being made by" — the connector's agent actor when
 * nobody can be named, and the linked user's current org roles when somebody can. A third one
 * added to that question belongs here.
 *
 * No model layers: `McpToolRuntimeRequirements` has no model member, so no approval-gated tool can
 * reach one.
 */
export const ChatApplyServicesLive = Layer.mergeAll(
	McpServicesLive,
	ErrorActorsService.layer,
	OrgMembershipService.layer,
).pipe(Layer.provide(Layer.mergeAll(Env.layer, EdgeCacheServiceLive)))

/** What a chat turn's runtime needs beyond the tools: the two completion tools' services. */
export const InvestigationServicesLive = Layer.mergeAll(
	McpServicesLive,
	// The turn resolves its own actor before the run: a connector turn acts as the linked Maple
	// user under their current roles, or as the connector's agent when nobody is linked.
	ErrorActorsService.layer,
	OrgMembershipService.layer.pipe(Layer.provide(Layer.mergeAll(Env.layer, EdgeCacheServiceLive))),
	InvestigationService.layer.pipe(Layer.provide(Env.layer)),
	// The review reads production telemetry through the warehouse, which caches at the edge.
	PrReviewService.layer.pipe(Layer.provide(Layer.mergeAll(Env.layer, EdgeCacheServiceLive))),
	PrReviewConversationService.layer.pipe(Layer.provide(Layer.mergeAll(Env.layer, EdgeCacheServiceLive))),
	// The org's own OpenRouter key, when it holds the add-on; the add-on check reads the cached customer.
	OrgOpenRouterKeyService.layer.pipe(Layer.provide(Layer.mergeAll(Env.layer, EdgeCacheServiceLive))),
)
