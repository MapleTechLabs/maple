/**
 * The heavy half of the relay object: the ports an inbound event is handled against, and the
 * Effect runtime it runs in.
 *
 * Imported dynamically by `ConnectorRelay`, for the same reason `ChatSession` imports its turn
 * runner that way — everything below reaches the connector registry, the agent's wire contract and
 * the database, and none of it belongs on the path Cloudflare evaluates when it validates the
 * uploaded script.
 */
import type { ChatConnector, ConnectorCredentials, InboundEvent } from "@maple/chat-platform"
import { connectors } from "@maple/chat-platform/connectors"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { chatSessionStub } from "@maple/domain/chat-session-stub"
import type { ChatConnectorId, OrgId } from "@maple/domain/primitives"
import type { IntegrationsPersistenceError } from "@maple/domain/http"
import { workerTelemetryConfig } from "@maple/infra/worker-telemetry"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { chatChartImageUrl } from "@maple/backend/services/chat/chat-chart"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { layerPg } from "@maple/backend/platform/DatabasePgLive"
import { mapleDbConnectionLayer } from "@maple/backend/platform/pg-connection-source"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import { resolveChatIdentity } from "@maple/backend/services/integrations/chat-identity-rows"
import {
	forgetChatWorkspace,
	resolveChatWorkspace,
} from "@maple/backend/services/integrations/chat-workspace-rows"
import { resolveConnectorConfig } from "../config.ts"
import { relayWithWorkspace, WorkspaceLookupFailed, type RelayPorts, type ResolvedWorkspace } from "./turn.ts"

/**
 * This Worker's own SDK instance, at module scope so its buffers are the isolate's.
 *
 * The relay runs under the object's `waitUntil`, outside any request the bridge built telemetry
 * for, so the spans a turn produces are exported from here or not at all — and flushed when the
 * event is done, because nothing else closes a scope around it.
 */
const telemetry = MapleCloudflareSDK.make(workerTelemetryConfig({ serviceName: "maple-chat-bot" }))

/** A plain string off the Worker env, treating blank as absent, the way connector config is read. */
const setting = (env: Record<string, unknown>, name: string): string | undefined => {
	const value = env[name]
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

const APP_BASE_URL_FALLBACK = "https://app.maple.dev"

const appBaseUrl = (env: Record<string, unknown>): string =>
	setting(env, "MAPLE_APP_BASE_URL") ?? APP_BASE_URL_FALLBACK

/** `MAPLE_INGEST_KEY_ENCRYPTION_KEY` is set on this deployment but is not a usable key. */
class CredentialKeyUnusable extends Schema.TaggedError<CredentialKeyUnusable>()(
	"@maple/chat-bot/CredentialKeyUnusable",
	{ message: Schema.String },
) {}

/**
 * The key a connector's per-workspace credential was sealed with, or `null` where this deployment
 * binds none.
 *
 * Optional because most of this Worker does not need it: a connector whose credential is one
 * deployment-wide secret stores nothing to open, and a stage without the key runs those normally.
 * A workspace that DID store one then fails its lookup rather than resolving without its token —
 * see `chat-workspace-rows.ts`.
 */
const credentialKey = (env: Record<string, unknown>): Effect.Effect<Buffer | null> =>
	parseBase64Aes256GcmKey(
		setting(env, "MAPLE_INGEST_KEY_ENCRYPTION_KEY") ?? "",
		(message) => new CredentialKeyUnusable({ message }),
	).pipe(
		// Absent is the ordinary case on a stage running no connector that stores a credential, so
		// it is not an error — but a key that IS set and unusable is a deployment mistake that
		// would otherwise surface only as an unreadable workspace on every mention, reason nowhere.
		Effect.tapError((error) =>
			setting(env, "MAPLE_INGEST_KEY_ENCRYPTION_KEY") === undefined
				? Effect.void
				: Effect.logError("Chat workspace credential key is unusable").pipe(
						Effect.annotateLogs({ "error.type": error._tag, "error.message": error.message }),
					),
		),
		Effect.orElseSucceed(() => null),
	)

export interface RelayHost {
	readonly env: Record<string, unknown>
	/** Whether this conversation has already been told that its workspace is not linked. */
	readonly announceUnlinked: Effect.Effect<boolean>
	/** The relay object's own record of the conversations the bot opened — see `ConnectorRelay`. */
	readonly ownsConversation: RelayPorts["ownsConversation"]
	readonly rememberConversation: RelayPorts["rememberConversation"]
}

/**
 * One Postgres connection per inbound event, opened lazily and released as soon as the row is
 * read — well before the turn it starts has finished streaming. Sockets are bound to the
 * invocation that opened them, and a relayed turn outlives every statement it makes.
 */
const withDatabase = <A, E>(env: Record<string, unknown>, program: Effect.Effect<A, E, Database>) =>
	withPgConnectionScope(program).pipe(
		// The connection's lifetime IS this scope — it is released with the lookup, not with the
		// turn the lookup starts.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(Layer.provideMerge(layerPg, mapleDbConnectionLayer(env))),
	)

/**
 * Logged where the cause is, and re-raised as the relay's own failure: what the relay must not do
 * is mistake a database it could not read for a workspace nobody linked.
 */
const lookupFailed =
	(connectorId: ChatConnectorId, message: string) =>
	<A>(effect: Effect.Effect<A, IntegrationsPersistenceError>) =>
		effect.pipe(
			Effect.catchCause((cause) =>
				// Interrupts stay interrupts: a relay cut short mid-lookup has nobody to answer, and
				// reporting "the workspace could not be read" into the channel would be a lie told by
				// a fiber that should already have stopped.
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.logError("Chat workspace could not be resolved").pipe(
							Effect.annotateLogs({ "error.type": summarizeCause(cause) }),
							Effect.andThen(
								Effect.fail(new WorkspaceLookupFailed({ connector: connectorId, message })),
							),
						),
			),
		)

/**
 * The workspace this event belongs to: which org, which Maple user the clicker linked, and the
 * credential the connector posts with — in ONE connection.
 *
 * Sequential rather than parallel because the second question needs the first one's answer: a link
 * is per org, and the org is what the workspace names.
 *
 * The credential rides along because it comes out of the same row, and reading that row twice —
 * once to answer the relay and once to build the transport — would be two Postgres connections for
 * one mention.
 */
const lookupWorkspace = (
	host: RelayHost,
	connector: ChatConnector<HttpClient.HttpClient | ConnectorCredentials>,
	connectorId: ChatConnectorId,
	workspaceId: string,
	externalUserId: string | undefined,
) =>
	Effect.flatMap(credentialKey(host.env), (key) =>
		withDatabase(
			host.env,
			Effect.gen(function* () {
				const database = yield* Database
				const workspace = yield* resolveChatWorkspace(database, connectorId, workspaceId, key)
				if (Option.isNone(workspace)) return Option.none<ResolvedWorkspace>()
				const credentials = workspace.value.credentials
				// Nothing to link with, or nobody asked: one query.
				if (externalUserId === undefined || connector.identity === undefined) {
					return Option.some<ResolvedWorkspace>({
						relay: { orgId: workspace.value.orgId },
						credentials,
					})
				}
				const identity = yield* resolveChatIdentity(
					database,
					workspace.value.orgId,
					connectorId,
					externalUserId,
				)
				return Option.some<ResolvedWorkspace>({
					relay: {
						orgId: workspace.value.orgId,
						...(Option.isNone(identity) ? undefined : { linkedUserId: identity.value.userId }),
					},
					credentials,
				})
			}),
		).pipe(lookupFailed(connectorId, "The chat workspace could not be read")),
	)

const ports = (
	host: RelayHost,
	connector: ChatConnector<HttpClient.HttpClient | ConnectorCredentials>,
	resolveWorkspace: RelayPorts["resolveWorkspace"],
): RelayPorts<HttpClient.HttpClient | ConnectorCredentials> => ({
	outbound: connector.outbound,
	supportsIdentity: connector.identity !== undefined,
	resolveWorkspace,
	forgetWorkspace: (connectorId, workspaceId) =>
		withDatabase(
			host.env,
			Effect.flatMap(Database, (database) => forgetChatWorkspace(database, connectorId, workspaceId)),
		).pipe(
			Effect.flatMap((forgotten) =>
				forgotten
					? Effect.logInfo("Chat workspace unlinked after the bot was removed").pipe(
							Effect.annotateLogs({ "maple.chat.connector": connectorId }),
						)
					: Effect.void,
			),
			Effect.catchCause((cause) =>
				Effect.logError("Chat workspace could not be unlinked").pipe(
					Effect.annotateLogs({ "error.type": summarizeCause(cause) }),
				),
			),
		),
	chatSession: (sessionId) => chatSessionStub(host.env, sessionId),
	appBaseUrl: appBaseUrl(host.env),
	chartImageUrl: (orgId: OrgId, ref) =>
		chatChartImageUrl({
			appBaseUrl: appBaseUrl(host.env),
			hmacKey: setting(host.env, "MAPLE_SHARE_TOKEN_HMAC_KEY") ?? null,
			orgId,
			sessionId: ref.sessionId,
			messageId: ref.messageId,
			chartIndex: ref.chartIndex,
		}),
	announceUnlinked: host.announceUnlinked,
	ownsConversation: host.ownsConversation,
	rememberConversation: host.rememberConversation,
})

/**
 * Handle one inbound event to completion.
 *
 * A connector this build does not carry, or one whose configuration was removed under a live
 * connection, is dropped here: the event cannot be answered on a platform there is no credential
 * for, and the trigger already says so once per isolate.
 */
export const runInboundEvent = async (host: RelayHost, event: InboundEvent): Promise<void> => {
	const connector = connectors.find((candidate) => candidate.id === event.connector)
	if (connector === undefined) return
	const config = resolveConnectorConfig(host.env, connector)
	if (config._tag === "missing") return

	await Effect.runPromise(
		relayWithWorkspace(
			event,
			config.config,
			lookupWorkspace(
				host,
				connector,
				event.connector,
				event.workspaceId,
				// Only a click names a person; a message is answered for the workspace.
				event.type === "action" ? event.actor.id : undefined,
			),
			(resolveWorkspace) => ports(host, connector, resolveWorkspace),
		).pipe(
			// oxlint-disable-next-line effecttsgo/strict-effect-provide
			Effect.provide(Layer.mergeAll(FetchHttpClient.layer, workerEnvLayer(host.env), telemetry.layer)),
			// On the fiber rather than in a `finally`: the flush is what exports this event's spans,
			// so it belongs to the same interruption and failure handling they do.
			Effect.ensuring(Effect.promise(() => telemetry.flush(host.env).catch(() => undefined))),
		),
	)
}
