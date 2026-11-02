import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import {
	readMcpOverview,
	readMcpServers,
	readMcpSession,
	readMcpSessions,
	readMcpTool,
} from "@maple/backend/services/mcp/mcp-reads"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"

/** The MCP hub's reads (`/mcp-servers`), scoped by `CurrentTenant`; the reads and their spans live in `mcp-reads`. */
const withTenant =
	<Payload, A, E, R>(read: (tenant: TenantContext, payload: Payload) => Effect.Effect<A, E, R>) =>
	({ payload }: { readonly payload: Payload }) =>
		Effect.flatMap(CurrentTenant.Context, (tenant) => read(tenant, payload))

export const HttpMcpInternalLive = HttpApiBuilder.group(MapleInternalApi, "mcpInternal", (handlers) =>
	handlers
		.handle("servers", withTenant(readMcpServers))
		.handle("overview", withTenant(readMcpOverview))
		.handle("tool", withTenant(readMcpTool))
		.handle("sessions", withTenant(readMcpSessions))
		.handle("session", withTenant(readMcpSession)),
)
