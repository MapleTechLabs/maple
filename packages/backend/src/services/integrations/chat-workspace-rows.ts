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
import {
	openChatWorkspaceCredentials,
	storedCredentials,
} from "@maple/backend/services/integrations/chat-workspace-credentials"

/** What the bot Worker needs to act on an inbound event. */
export interface ChatWorkspaceResolution {
	readonly orgId: OrgId
	readonly workspaceId: ChatWorkspaceId
	readonly settings: ChatWorkspaceSettings
	/**
	 * The connector's own per-workspace secret, decrypted, or `undefined` for a connector that
	 * stored none. The host puts it in `ConnectorCredentials` under `WORKSPACE_CREDENTIALS`; it is
	 * the connector's encoding and nothing here reads it.
	 */
	readonly credentials: string | undefined
}

const decodeStored = Schema.decodeUnknownEffect(
	Schema.Struct({
		orgId: OrgId,
		id: ChatWorkspaceId,
		settings: Schema.Record(Schema.String, Schema.String),
	}),
)

const persistenceError = (error: DatabaseError) =>
	new IntegrationsPersistenceError({ message: `${error._tag}: ${error.message}` })

const unreadable = (message: string) => new IntegrationsPersistenceError({ message })

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
	/**
	 * The key the credential envelope was sealed with, or `null` on a deployment that has none.
	 * A row that carries a credential no key can open fails the resolution rather than resolving to
	 * a workspace whose connector then cannot post — the second is a bot that answers nothing and
	 * says why nowhere.
	 */
	encryptionKey: Buffer | null = null,
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
			Effect.mapError((error) => unreadable(`Stored chat workspace is unreadable: ${error.message}`)),
		)
		const sealed = storedCredentials(row)
		if (sealed === null) {
			return Option.some({
				orgId: stored.orgId,
				workspaceId: stored.id,
				settings: stored.settings,
				credentials: undefined,
			})
		}
		if (encryptionKey === null) {
			return yield* Effect.fail(
				unreadable("This chat workspace stores a credential and this deployment has no key for it"),
			)
		}
		const credentials = yield* openChatWorkspaceCredentials(
			sealed,
			encryptionKey,
			{ orgId: stored.orgId, connector: connectorId, externalWorkspaceId },
			// The message never carries the cause: everything below it is key material and ciphertext.
			(message) => unreadable(`Stored chat workspace credential is unreadable: ${message}`),
		)
		return Option.some({
			orgId: stored.orgId,
			workspaceId: stored.id,
			settings: stored.settings,
			credentials,
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
