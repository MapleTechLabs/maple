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
import type { ChatConnectorId, OrgId } from "@maple/domain/primitives"
import type { IntegrationsPersistenceError } from "@maple/domain/http"
import { workerTelemetryConfig } from "@maple/infra/worker-telemetry"
import { ChatSessions, type ChatSessionsApi } from "@maple/backend/platform/bindings"
import { envPorts } from "@maple/backend/platform/env-ports"
import { Cause, Config, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
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
import { optionalSecret, optionalSetting, resolveConnectorConfig } from "../config.ts"
import { decodeRelayTurnCheckpoint, settleRelayedTurn, type SettleOutcome } from "./settle.ts"
import {
	relayWithWorkspace,
	withWorkspace,
	WorkspaceLookupFailed,
	type RelayPorts,
	type ResolvedWorkspace,
} from "./turn.ts"

/**
 * This Worker's own SDK instance, at module scope so its buffers are the isolate's.
 *
 * The relay runs under the object's `waitUntil`, outside any request the bridge built telemetry
 * for, so the spans a turn produces are exported from here or not at all — and flushed when the
 * event is done, because nothing else closes a scope around it.
 */
const telemetry = MapleCloudflareSDK.make(workerTelemetryConfig({ serviceName: "maple-chat-bot" }))

const APP_BASE_URL_FALLBACK = "https://app.maple.dev"

/**
 * The Worker settings a relayed event reads, through the env's `ConfigProvider` (`envPorts`).
 * Blank counts as absent, the way connector config is read; the two keys stay `Redacted`.
 */
const relaySettings = Config.all({
	appBaseUrl: optionalSetting("MAPLE_APP_BASE_URL").pipe(
		Config.map(Option.getOrElse(() => APP_BASE_URL_FALLBACK)),
	),
	shareTokenHmacKey: optionalSecret("MAPLE_SHARE_TOKEN_HMAC_KEY"),
	credentialKey: optionalSecret("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
})

type RelaySettings = Config.Success<typeof relaySettings>

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
const credentialKey = (settings: RelaySettings): Effect.Effect<Buffer | null> =>
	parseBase64Aes256GcmKey(
		Option.match(settings.credentialKey, { onNone: () => "", onSome: Redacted.value }),
		(message) => new CredentialKeyUnusable({ message }),
	).pipe(
		// Absent is the ordinary case on a stage running no connector that stores a credential, so
		// it is not an error — but a key that IS set and unusable is a deployment mistake that
		// would otherwise surface only as an unreadable workspace on every mention, reason nowhere.
		Effect.tapError((error) =>
			Option.isNone(settings.credentialKey)
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
	/** The relay object's checkpoint of the turn it is rendering — see `./settle.ts`. */
	readonly recordTurn: RelayPorts["recordTurn"]
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
	settings: RelaySettings,
	connector: ChatConnector<HttpClient.HttpClient | ConnectorCredentials>,
	connectorId: ChatConnectorId,
	workspaceId: string,
	externalUserId: string | undefined,
) =>
	Effect.flatMap(credentialKey(settings), (key) =>
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

/** What a relayed event reads from the graph rather than the object: settings and the chat-session port. */
interface RelayEnvironment {
	readonly settings: RelaySettings
	readonly chatSessions: ChatSessionsApi
}

const relayEnvironment: Effect.Effect<RelayEnvironment, never, ChatSessions> = Effect.gen(function* () {
	return {
		// Every setting recovers its own ConfigError (`optionalSetting`), so this cannot fail.
		settings: yield* Effect.orDie(relaySettings),
		chatSessions: yield* ChatSessions,
	}
})

const ports = (
	host: RelayHost,
	{ settings, chatSessions }: RelayEnvironment,
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
	chatSession: (sessionId) => chatSessions.stub(sessionId),
	appBaseUrl: settings.appBaseUrl,
	chartImageUrl: (orgId: OrgId, ref) =>
		chatChartImageUrl({
			appBaseUrl: settings.appBaseUrl,
			hmacKey: Option.match(settings.shareTokenHmacKey, { onNone: () => null, onSome: Redacted.value }),
			orgId,
			sessionId: ref.sessionId,
			messageId: ref.messageId,
			chartIndex: ref.chartIndex,
		}),
	announceUnlinked: host.announceUnlinked,
	ownsConversation: host.ownsConversation,
	rememberConversation: host.rememberConversation,
	recordTurn: host.recordTurn,
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

	await Effect.runPromise(
		Effect.gen(function* () {
			const config = yield* resolveConnectorConfig(connector)
			if (config._tag === "missing") return
			const environment = yield* relayEnvironment
			yield* relayWithWorkspace(
				event,
				config.config,
				lookupWorkspace(
					host,
					environment.settings,
					connector,
					event.connector,
					event.workspaceId,
					// Only a click names a person; a message is answered for the workspace.
					event.type === "action" ? event.actor.id : undefined,
				),
				(resolveWorkspace) => ports(host, environment, connector, resolveWorkspace),
			)
		}).pipe(inRuntime(host.env)),
	)
}

/** This Worker's runtime for an event's or a settle's Effect, and the flush that exports its spans. */
const inRuntime =
	(env: Record<string, unknown>) =>
	<A>(program: Effect.Effect<A, never, HttpClient.HttpClient | ChatSessions>) =>
		program.pipe(
			// oxlint-disable-next-line effecttsgo/strict-effect-provide
			Effect.provide(Layer.mergeAll(FetchHttpClient.layer, envPorts(env), telemetry.layer)),
			// On the fiber rather than in a `finally`: the flush is what exports this event's spans,
			// so it belongs to the same interruption and failure handling they do.
			Effect.ensuring(Effect.promise(() => telemetry.flush(env).catch(() => undefined))),
		)

/**
 * Settle a turn an evicted activation was relaying, through the same connector, config and lazy
 * workspace read a new event gets. The conversation ports only a new message asks are inert.
 */
export const settleInboundTurn = async (
	host: Pick<RelayHost, "env" | "recordTurn">,
	stored: unknown,
): Promise<SettleOutcome> => {
	const checkpoint = decodeRelayTurnCheckpoint(stored)
	const connector = Option.isNone(checkpoint)
		? undefined
		: connectors.find((candidate) => candidate.id === checkpoint.value.connector)
	const relayHost: RelayHost = {
		...host,
		announceUnlinked: Effect.succeed(false),
		ownsConversation: () => Effect.succeed(false),
		rememberConversation: () => Effect.void,
	}
	return Effect.runPromise(
		Effect.gen(function* () {
			const config = connector === undefined ? undefined : yield* resolveConnectorConfig(connector)
			if (Option.isNone(checkpoint) || connector === undefined || config?._tag !== "ready") {
				yield* Effect.logWarning("A turn checkpoint this build cannot settle was dropped")
				return "done" satisfies SettleOutcome
			}
			const environment = yield* relayEnvironment
			const { target } = checkpoint.value
			return yield* withWorkspace(
				config.config,
				lookupWorkspace(
					relayHost,
					environment.settings,
					connector,
					checkpoint.value.connector,
					target.workspaceId,
					undefined,
				),
				(resolveWorkspace) => ports(relayHost, environment, connector, resolveWorkspace),
				(settlePorts) => settleRelayedTurn(checkpoint.value, settlePorts),
			)
		}).pipe(inRuntime(host.env)),
	)
}
