/**
 * The two chat-workspace rows a connector's host Worker touches, as queries over `Database` alone.
 *
 * Apart from `ChatWorkspaceService` because the Worker that answers mentions is not the dashboard:
 * it links nothing, so it needs neither OAuth state, nor an HTTP client, nor the connector config
 * the service acquires — and taking the service would put the api's whole environment on a Worker
 * that reads one row per mention. The service calls these same functions, so there is one query
 * per question rather than two.
 */
import { chatWorkspaces } from "@maple/db"
import type { ChatWorkspaceSettings } from "@maple/chat-platform"
import { ChatConnectorId, ChatWorkspaceId, IntegrationsPersistenceError, OrgId } from "@maple/domain/http"
import { and, eq } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { DatabaseApi, DatabaseError } from "@maple/backend/platform/DatabaseLive"

/** What the bot Worker needs to act on an inbound event. */
export interface ChatWorkspaceResolution {
	readonly orgId: OrgId
	readonly workspaceId: ChatWorkspaceId
	readonly settings: ChatWorkspaceSettings
}

const decodeStored = Schema.decodeUnknownEffect(
	Schema.Struct({
		orgId: OrgId,
		id: ChatWorkspaceId,
		settings: Schema.Record(Schema.String, Schema.String),
	}),
)

const persistenceError = (error: DatabaseError | { readonly message: string }) =>
	new IntegrationsPersistenceError({ message: error.message })

/**
 * The org a workspace belongs to, or `None` when nothing has linked it.
 *
 * The stored columns are decoded rather than trusted: their types are a cast over whatever is in
 * the table, and an unreadable row is this function's failure rather than a bad org id reaching a
 * session id.
 */
export const resolveChatWorkspace = (
	database: DatabaseApi,
	connectorId: ChatConnectorId,
	externalWorkspaceId: string,
): Effect.Effect<Option.Option<ChatWorkspaceResolution>, IntegrationsPersistenceError> =>
	Effect.gen(function* () {
		const rows = yield* database
			.execute((db) =>
				db
					.select()
					.from(chatWorkspaces)
					.where(
						and(
							eq(chatWorkspaces.connector, connectorId),
							eq(chatWorkspaces.externalWorkspaceId, externalWorkspaceId),
						),
					)
					.limit(1),
			)
			.pipe(Effect.mapError(persistenceError))
		const row = rows[0]
		if (row === undefined) return Option.none<ChatWorkspaceResolution>()
		const stored = yield* decodeStored(row).pipe(
			Effect.mapError((error) =>
				persistenceError({ message: `Stored chat workspace is unreadable: ${error.message}` }),
			),
		)
		return Option.some({
			orgId: stored.orgId,
			workspaceId: stored.id,
			settings: stored.settings,
		})
	})

/**
 * Drop the link for a workspace the bot was removed from, and answer whether there was one.
 *
 * By the platform's own id rather than by org: the event says a workspace no longer has the bot in
 * it, and which org had linked it is exactly what this deletes.
 */
export const forgetChatWorkspace = (
	database: DatabaseApi,
	connectorId: ChatConnectorId,
	externalWorkspaceId: string,
): Effect.Effect<boolean, IntegrationsPersistenceError> =>
	Effect.gen(function* () {
		const deleted = yield* database
			.execute((db) =>
				db
					.delete(chatWorkspaces)
					.where(
						and(
							eq(chatWorkspaces.connector, connectorId),
							eq(chatWorkspaces.externalWorkspaceId, externalWorkspaceId),
						),
					)
					.returning({ id: chatWorkspaces.id }),
			)
			.pipe(Effect.mapError(persistenceError))
		return deleted.length > 0
	})
