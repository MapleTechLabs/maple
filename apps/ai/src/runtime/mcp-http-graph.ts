/**
 * `/mcp`, the public MCP transport, as a route graph of its own: a raw router because the
 * protocol is JSON-RPC over one POST rather than a set of typed endpoints.
 *
 * Separate from `./http-graph` so a cold isolate serving `/mcp` loads only the transport and
 * the auth graph, not the chat, security-audit, triage and tool-catalog routes. The tools
 * themselves load on the first `tools/call` (`McpToolExecutorLoader`).
 *
 * The api still owns the hostname and forwards `/mcp` here over a service binding, which is
 * what keeps its OAuth issuer and RFC 8707 resource identifiers on api's origin.
 */
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { API_CORS_OPTIONS } from "@maple/backend/http/api-cors"
import { McpLive } from "../mcp/app"
import { rawRoutes } from "./raw-routes"

export const McpRoutes = rawRoutes(McpLive).pipe(Layer.provideMerge(HttpRouter.cors(API_CORS_OPTIONS)))
