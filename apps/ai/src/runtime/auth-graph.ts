import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { McpToolRateLimiter } from "@maple/backend/services/auth/McpToolRateLimiter"
import { OrgMembershipService } from "@maple/backend/services/auth/OrgMembershipService"
import { SessionAuthorizationLive } from "@maple/backend/services/auth/SessionAuthorizationLive"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"
import { Layer } from "effect"

/**
 * What authenticates a request here.
 *
 * `/mcp` resolves its own tenant inside the transport, from an API key, an MCP
 * OAuth bearer or a session cookie, so it needs `ApiKeysService` and the tool
 * rate limiter rather than a route-level authorization layer. The chat routes
 * are session-only, the same as they were on api.
 *
 * `McpOAuthRateLimit` is deliberately absent: the OAuth endpoints stayed on
 * api, which still owns its own limiter for them.
 */
export const AiAuthLive = Layer.mergeAll(SessionAuthorizationLive).pipe(
	// `/mcp` falls back to session auth when the bearer is neither an API key nor
	// an MCP OAuth token, so the transport resolves tenants through this too.
	Layer.provideMerge(AuthService.layer),
	Layer.provideMerge(McpToolRateLimiter.layer),
	Layer.provideMerge(ApiKeysService.layer),
	// `/mcp` checks a requested agent identity against the org's actors.
	Layer.provideMerge(ErrorActorsService.layer),
	Layer.provideMerge(OrganizationRegionService.layer),
	// Denied attempts and audited reads are recorded from inside the auth layers.
	Layer.provideMerge(AuditLogService.layer.pipe(Layer.provide(Env.layer))),
	// The directory an `org:custom` session's permissions come from, for the chat routes and `/mcp`
	// alike; without it such a session holds nothing.
	Layer.provideMerge(OrgMembershipService.layer),
	Layer.provideMerge(Layer.mergeAll(Env.layer, EdgeCacheServiceLive)),
)
