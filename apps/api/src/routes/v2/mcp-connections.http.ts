import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2, isoTimestamp, paginateArray } from "@maple/domain/http/v2"
import type { V2McpConnection } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { isAdmin } from "@maple/backend/services/auth/auth"
import { McpConnectionsService, type McpConnection } from "@maple/backend/services/auth/McpConnectionsService"

const toV2McpConnection = (connection: McpConnection): V2McpConnection => ({
	id: connection.id,
	object: "mcp_connection",
	client_name: connection.clientName,
	user_id: connection.userId,
	user_email: connection.userEmail,
	scopes: connection.scopes,
	connected_at: isoTimestamp(connection.connectedAt),
	last_refreshed_at: isoTimestamp(connection.lastRefreshedAt),
	expires_at: isoTimestamp(connection.expiresAt),
})

/** Admins manage every member's connections; anyone else only the ones they approved. */
const currentViewer = Effect.gen(function* () {
	const tenant = yield* CurrentTenant.Context
	return { orgId: tenant.orgId, viewer: { userId: tenant.userId, seesAll: isAdmin(tenant.roles) } }
})

export const HttpV2McpConnectionsLive = HttpApiBuilder.group(MapleApiV2, "mcpConnections", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* McpConnectionsService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const { orgId, viewer } = yield* currentViewer
					const live = yield* connections.list(orgId, viewer)
					const page = yield* paginateArray(live.map(toV2McpConnection), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("revoke", ({ params }) =>
				Effect.gen(function* () {
					const { orgId, viewer } = yield* currentViewer
					const revoked = yield* connections.revoke(orgId, params.id, viewer)
					yield* recordHttpAudit("mcp_connection.revoked", {
						resourceId: revoked.id,
						affectedUserId: revoked.userId,
						metadata: { client_name: revoked.clientName },
					})
					return toV2McpConnection(revoked)
				}),
			)
	}),
)
