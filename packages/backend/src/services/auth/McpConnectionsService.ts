import * as PG from "@maple-dev/effect-orm/postgres"
import { McpOAuthClients, McpOAuthRefreshTokens, type McpOAuthRefreshTokenRow } from "@maple/db/tables"
import { McpConnectionNotFoundError, McpConnectionPersistenceError } from "@maple/domain/http"
import { McpConnectionId, type OrgId, type UserId } from "@maple/domain/primitives"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { REFRESH_FAMILY_ABSOLUTE_TTL_MS, revokeRefreshFamily } from "./mcp-oauth-family"

/**
 * MCP clients connected through OAuth, one per refresh-token family. The hourly access keys a
 * family mints are an implementation detail; the family is what a member approved and revokes.
 */

export interface McpConnection {
	readonly id: McpConnectionId
	readonly clientName: string
	readonly userId: UserId
	readonly userEmail: string | null
	readonly scopes: ReadonlyArray<string>
	readonly connectedAt: number
	readonly lastRefreshedAt: number
	readonly expiresAt: number
}

/** Who is asking: admins see every member's connections, everyone else only their own. */
export interface McpConnectionViewer {
	readonly userId: UserId
	readonly seesAll: boolean
}

export interface McpConnectionsServiceApi {
	readonly list: (
		orgId: OrgId,
		viewer: McpConnectionViewer,
	) => Effect.Effect<ReadonlyArray<McpConnection>, McpConnectionPersistenceError>
	readonly revoke: (
		orgId: OrgId,
		id: McpConnectionId,
		viewer: McpConnectionViewer,
	) => Effect.Effect<McpConnection, McpConnectionNotFoundError | McpConnectionPersistenceError>
}

const makePersistenceError = makePersistenceErrorMapper(
	McpConnectionPersistenceError,
	"MCP connection persistence failed",
)

const decodeConnectionId = Schema.decodeUnknownOption(McpConnectionId)

/** The family's live token, newest first; families without one have ended. */
const latestPerFamily = (rows: ReadonlyArray<McpOAuthRefreshTokenRow>, now: number) => {
	const seen = new Set<string>()
	return rows.filter((row) => {
		if (seen.has(row.familyId)) return false
		seen.add(row.familyId)
		return row.familyExpiresAt === null || row.familyExpiresAt > now
	})
}

const toConnection = (
	row: McpOAuthRefreshTokenRow,
	clientNames: ReadonlyMap<string, string>,
): Option.Option<McpConnection> =>
	Option.map(decodeConnectionId(row.familyId), (id) => ({
		id,
		clientName: clientNames.get(row.clientId) ?? "MCP client",
		userId: row.userId,
		userEmail: row.userEmail,
		scopes: row.scopes,
		// The ceiling is set once at approval, so it dates the approval exactly; a pre-column
		// row falls back to its own issue time.
		connectedAt:
			row.familyExpiresAt === null
				? row.createdAt
				: row.familyExpiresAt - REFRESH_FAMILY_ABSOLUTE_TTL_MS,
		lastRefreshedAt: row.createdAt,
		expiresAt: row.familyExpiresAt ?? row.expiresAt,
	}))

export class McpConnectionsService extends Context.Service<McpConnectionsService, McpConnectionsServiceApi>()(
	"@maple/backend/services/auth/McpConnectionsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "McpConnectionsService", makePersistenceError)

			const liveConnections = Effect.fn("McpConnectionsService.liveConnections")(function* (
				orgId: OrgId,
				viewer: McpConnectionViewer,
				familyId?: McpConnectionId,
			) {
				const now = yield* Clock.currentTimeMillis
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(McpOAuthRefreshTokens)
							.select()
							.where(($) => [
								$.orgId.eq(orgId),
								viewer.seesAll ? undefined : $.userId.eq(viewer.userId),
								familyId === undefined ? undefined : $.familyId.eq(familyId),
								$.revokedAt.isNull(),
								$.expiresAt.gt(now),
							])
							.orderBy(["createdAt", "desc"]),
					),
				)
				const live = latestPerFamily(rows, now)
				const [first, ...rest] = [...new Set(live.map((row) => row.clientId))]
				const clients =
					first === undefined
						? []
						: yield* dbExecute((db) =>
								db.run(
									PG.from(McpOAuthClients)
										.select("clientId", "clientName")
										.where(($) => [$.clientId.in_(first, ...rest)]),
								),
							)
				const clientNames = new Map(clients.map((client) => [client.clientId, client.clientName]))
				return live.flatMap((row) => Option.toArray(toConnection(row, clientNames)))
			})

			const list = Effect.fn("McpConnectionsService.list")(function* (
				orgId: OrgId,
				viewer: McpConnectionViewer,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": viewer.userId })
				return yield* liveConnections(orgId, viewer)
			})

			const revoke = Effect.fn("McpConnectionsService.revoke")(function* (
				orgId: OrgId,
				id: McpConnectionId,
				viewer: McpConnectionViewer,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": viewer.userId })
				const [connection] = yield* liveConnections(orgId, viewer, id)
				if (connection === undefined) {
					return yield* new McpConnectionNotFoundError({
						message: "No active MCP connection with this ID",
						connectionId: id,
					})
				}
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) => db.transaction(revokeRefreshFamily(db, id, now)))
				return connection
			})

			return { list, revoke }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
