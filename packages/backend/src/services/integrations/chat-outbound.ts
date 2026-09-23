/**
 * Reaching a linked workspace's connector from a host that posts without receiving anything: alert
 * delivery, and the channel listing behind its picker.
 *
 * Over `Database` alone, like `chat-workspace-rows.ts`, because the alerting Worker is one of these
 * hosts and must not take `ChatWorkspaceService` — its OAuth state and install flow are the api's
 * business. The workspace is always read by id AND org: an id is what a client sends, and the org
 * is what makes it theirs.
 */
import type { Buffer } from "node:buffer"
import { chatWorkspaces } from "@maple/db"
import {
	ConnectorCredentials,
	WORKSPACE_CREDENTIALS,
	type ChatConnector,
	type ChatOutboundTransport,
	type ConnectorConfig,
} from "@maple/chat-platform"
import { connectors } from "@maple/chat-platform/connectors"
import { ChatWorkspaceId, type OrgId } from "@maple/domain/http"
import { and, eq } from "drizzle-orm"
import { Array as Arr, Context, Effect, Option, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import type { DatabaseApi } from "@maple/backend/platform/DatabaseLive"
import {
	openChatWorkspaceCredentials,
	storedCredentials,
} from "@maple/backend/services/integrations/chat-workspace-credentials"

/** A registered connector, with the two services its outbound half asks its host for. */
export type RegisteredChatConnector = ChatConnector<HttpClient.HttpClient | ConnectorCredentials>

/**
 * The connectors a host resolves ids against. A reference rather than a direct import of the
 * registry: production gets the real one by default, and a test can hand the host a fake connector
 * and exercise it without a chat platform on the other end.
 */
export class ChatConnectorRegistry extends Context.Reference<ReadonlyArray<RegisteredChatConnector>>(
	"@maple/api/services/ChatConnectorRegistry",
	{ defaultValue: (): ReadonlyArray<RegisteredChatConnector> => connectors },
) {}

/**
 * The workspace's stored credential will not open — a rotated key, or an envelope that no longer
 * matches its row. Nothing retries its way past this: only a reinstall writes a new one.
 */
export class ChatWorkspaceCredentialsUnreadable extends Schema.TaggedError<ChatWorkspaceCredentialsUnreadable>()(
	"@maple/backend/ChatWorkspaceCredentialsUnreadable",
	{ message: Schema.String, workspaceId: ChatWorkspaceId },
) {}

/** A workspace the org linked, with the connector that owns it and its own credential opened. */
export interface OwnedChatWorkspace {
	readonly connector: RegisteredChatConnector
	readonly externalWorkspaceId: string
	readonly name: string
	/** The connector's per-workspace secret, or `undefined` for a connector that stored none. */
	readonly credentials: string | undefined
}

/**
 * The org's workspace by id, or `None` when the org has no such workspace — or links it through a
 * connector this build no longer ships, which is the same answer to a caller that wants to post.
 */
export const loadOwnedChatWorkspace = Effect.fn("loadOwnedChatWorkspace")(function* (
	database: DatabaseApi,
	registry: ReadonlyArray<RegisteredChatConnector>,
	orgId: OrgId,
	workspaceId: ChatWorkspaceId,
	encryptionKey: Buffer,
) {
	const rows = yield* database.execute((db) =>
		db
			.select()
			.from(chatWorkspaces)
			.where(and(eq(chatWorkspaces.id, workspaceId), eq(chatWorkspaces.orgId, orgId)))
			.limit(1),
	)
	const row = rows[0]
	if (row === undefined) return Option.none<OwnedChatWorkspace>()
	const connector = Arr.findFirst(registry, (candidate) => candidate.id === row.connector)
	if (Option.isNone(connector)) return Option.none<OwnedChatWorkspace>()
	yield* Effect.annotateCurrentSpan({ "chat.connector": connector.value.id })
	const sealed = storedCredentials(row)
	const credentials =
		sealed === null
			? undefined
			: yield* openChatWorkspaceCredentials(
					sealed,
					encryptionKey,
					{ orgId, connector: connector.value.id, externalWorkspaceId: row.externalWorkspaceId },
					// The message never carries the cause: everything below it is key material.
					(message) =>
						new ChatWorkspaceCredentialsUnreadable({
							message: `Stored chat workspace credential is unreadable: ${message}`,
							workspaceId,
						}),
				)
	return Option.some<OwnedChatWorkspace>({
		connector: connector.value,
		externalWorkspaceId: row.externalWorkspaceId,
		name: row.name,
		credentials,
	})
})

/**
 * The deployment-wide config names the workspace's connector declared and this host does not
 * have. Checked before a transport is built: a connector posting without its credential would
 * earn a refusal that reads as the org's grant being revoked, when it is this deployment's gap.
 */
export const missingOutboundConfig = (
	workspace: OwnedChatWorkspace,
	outboundConfig: ConnectorConfig,
): ReadonlyArray<string> =>
	workspace.connector.outbound.requiredConfig
		.filter((key) => !outboundConfig.has(key.name))
		.map((key) => key.name)

/**
 * The workspace's outbound transport, with the deployment's outbound config and the workspace's
 * own credential under `WORKSPACE_CREDENTIALS` — the same map the bot Worker builds for a turn.
 */
export const chatOutboundTransport = (
	workspace: OwnedChatWorkspace,
	outboundConfig: ConnectorConfig,
	httpClient: HttpClient.HttpClient,
): Effect.Effect<ChatOutboundTransport> =>
	workspace.connector.outbound.transport.pipe(
		Effect.provideService(
			ConnectorCredentials,
			Effect.succeed(
				workspace.credentials === undefined
					? outboundConfig
					: new Map(outboundConfig).set(WORKSPACE_CREDENTIALS, workspace.credentials),
			),
		),
		Effect.provideService(HttpClient.HttpClient, httpClient),
	)
