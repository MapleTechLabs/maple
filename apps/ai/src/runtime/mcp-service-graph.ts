import { Layer } from "effect"
import { McpToolExecutor } from "../mcp/dispatcher"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { OrgMembershipService } from "@maple/backend/services/auth/OrgMembershipService"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"

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

export const InvestigationServicesLive = Layer.mergeAll(
	McpServicesLive,
	// The turn resolves its own actor before the run: a connector turn acts as the connector's
	// agent, which the toolkit and the audit log both read off the tenant.
	ErrorActorsService.layer,
	InvestigationService.layer.pipe(Layer.provide(Env.layer)),
)
