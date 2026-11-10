import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi, type TenantContext } from "@maple/domain/http"
import { Effect } from "effect"
import { McpReadService } from "@maple/backend/services/mcp/McpReadService"

/** The MCP hub's reads (`/mcp-servers`), scoped by `CurrentTenant`, through `McpReadService`. */
const withTenant =
	<Payload, A, E>(read: (tenant: TenantContext, payload: Payload) => Effect.Effect<A, E>) =>
	({ payload }: { readonly payload: Payload }) =>
		Effect.flatMap(CurrentTenant.Context, (tenant) => read(tenant, payload))

export const HttpMcpInternalLive = HttpApiBuilder.group(MapleInternalApi, "mcpInternal", (handlers) =>
	Effect.gen(function* () {
		const reads = yield* McpReadService
		return handlers
			.handle("servers", withTenant(reads.servers))
			.handle("overview", withTenant(reads.overview))
			.handle("tool", withTenant(reads.tool))
			.handle("sessions", withTenant(reads.sessions))
			.handle("session", withTenant(reads.session))
	}),
)
