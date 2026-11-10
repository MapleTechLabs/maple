import { Context } from "effect"
import type { TenantContext } from "@maple/domain/http"

/** The tenant every MCP tool call runs under, provided per call by the executor. */
export class CurrentMcpTenant extends Context.Service<CurrentMcpTenant, TenantContext>()(
	"@maple/ai/mcp/CurrentMcpTenant",
) {}

/**
 * Adapter-local copy of the authenticated HTTP tenant.
 *
 * Effect's low-level MCP `addTool` contract only permits `McpServerClient` in a
 * handler's requirements, so it cannot express the `CurrentMcpTenant` service
 * installed by the outer HTTP middleware. A reference has a typed default and
 * therefore adds no requirement; the middleware overrides it for the request,
 * and the public MCP adapter passes the value to the closed executor explicitly.
 */
export class CurrentMcpRequestTenant extends Context.Reference<TenantContext | undefined>(
	"@maple/ai/mcp/CurrentMcpRequestTenant",
	{ defaultValue: () => undefined },
) {}
