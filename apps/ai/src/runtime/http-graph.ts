/**
 * Every route the AI Worker serves, as one layer.
 *
 * Three surfaces, and they are deliberately different shapes:
 *
 *   - `/mcp` — the public MCP transport, a raw router because the protocol is
 *     JSON-RPC over one POST rather than a set of typed endpoints.
 *   - `/api/chat/sessions/*` — the dashboard's chat transport, raw because
 *     `HttpApi` cannot model an open `text/event-stream`.
 *   - `/internal/chat/apply` — a typed `HttpApi` group, because re-running an
 *     approval-gated mutation is an ordinary request/response with a schema
 *     worth pinning.
 *
 * The api still owns the hostname. It forwards all three here over a service
 * binding, which is what keeps `/mcp`'s OAuth issuer and RFC 8707 resource
 * identifiers on api's origin — moving them would invalidate every registered
 * MCP client.
 */
import { MapleAiApi } from "@maple/domain/http"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { McpLive } from "@ai/mcp/app"
import { HttpChatLive } from "@ai/routes/internal/chat.http"
import { ChatSessionsRouter } from "@ai/routes/v1/chat-sessions.http"
import { HealthRouter } from "@ai/routes/health"
import { API_CORS_OPTIONS } from "@/http/api-cors"
import { Env } from "@/platform/Env"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import { AuditLogLive } from "@/runtime/warehouse-layer"
import { McpToolRateLimiter } from "@/services/auth/McpToolRateLimiter"
import { SessionAuthorizationLayer } from "@/services/auth/SessionAuthorizationLayer"
import { V1ErrorBoundaryLive } from "@/routes/v1/error-boundary"
import type { AiPortsLayer } from "@ai/worker/bindings"

/**
 * Services a raw router's handlers still expect from the request context, beyond the Worker's
 * ports, which every request carries. Each is a runtime "Service not found".
 */
type LeakedRequestServices<Routes extends Layer.Any> =
	Layer.Services<Routes> extends infer Marker
		? Marker extends HttpRouter.Request<"Requires", infer Service>
			? Exclude<Service, Layer.Success<AiPortsLayer>>
			: never
		: never

/**
 * A raw `HttpRouter` handler runs in the request's own context — unlike an `HttpApiBuilder`
 * group, nothing carries the router's build context into it — so a service it reads per request
 * has to arrive through `HttpRouter.provideRequest` (see `ChatSessionsRouter`). Read inside the
 * handler instead, it compiles, because the isolate builder erases the marker, and fails every
 * request with "Service not found", which is what took the chat routes down on 2026-09-08. This
 * turns that into a build failure naming the leaked service.
 *
 * Carried over from apps/api verbatim. It is worth more here, not less: this Worker is almost
 * entirely raw routers.
 */
const rawRoutes = <Routes extends Layer.Any>(
	routes: Routes &
		([LeakedRequestServices<Routes>] extends [never]
			? unknown
			: { readonly leakedRequestServices: LeakedRequestServices<Routes> }),
) => routes

const RawRoutes = rawRoutes(Layer.mergeAll(HealthRouter, ChatSessionsRouter, McpLive))

const AiInternalRoutes = HttpApiBuilder.layer(MapleAiApi).pipe(
	Layer.provide(HttpChatLive),
	Layer.provide(V1ErrorBoundaryLive),
)

export const AllRoutes = Layer.mergeAll(AiInternalRoutes, RawRoutes).pipe(
	Layer.provideMerge(HttpRouter.cors(API_CORS_OPTIONS)),
)

/**
 * What authenticates a request here.
 *
 * `/mcp` resolves its own tenant inside the transport, from an API key, an MCP
 * OAuth bearer or a session cookie, so it needs `ApiKeysService` and the tool
 * rate limiter rather than a route-level authorization layer. The chat routes
 * are session-only, the same as they were on api.
 *
 * `McpOAuthRateLimiter` is deliberately absent: the OAuth endpoints stayed on
 * api, which still owns its own limiter for them.
 */
export const AiAuthLive = Layer.mergeAll(SessionAuthorizationLayer).pipe(
	// `/mcp` falls back to session auth when the bearer is neither an API key nor
	// an MCP OAuth token, so the transport resolves tenants through this too.
	Layer.provideMerge(AuthService.layer),
	Layer.provideMerge(McpToolRateLimiter.layer),
	Layer.provideMerge(ApiKeysService.layer),
	// Denied attempts and audited reads are recorded from inside the auth layers.
	Layer.provideMerge(AuditLogLive.pipe(Layer.provide(Env.layer))),
	Layer.provideMerge(Env.layer),
)
