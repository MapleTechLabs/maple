/**
 * The heavy half of the relay object: the ports an inbound event is handled against, and the
 * Effect runtime it runs in.
 *
 * Imported dynamically by `ConnectorRelay`, for the same reason `ChatSession` imports its turn
 * runner that way — everything below reaches the connector registry, the agent's wire contract and
 * the database, and none of it belongs on the path Cloudflare evaluates when it validates the
 * uploaded script.
 */
import { ConnectorCredentials, type ChatConnector, type InboundEvent } from "@maple/chat-platform"
import { connectors } from "@maple/chat-platform/connectors"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { chatSessionStub } from "@maple/domain/chat-session-stub"
import type { OrgId } from "@maple/domain/primitives"
import { workerTelemetryConfig } from "@maple/infra/worker-telemetry"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { chatChartImageUrl } from "@maple/backend/services/chat/chat-chart"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { layerPg } from "@maple/backend/platform/DatabasePgLive"
import { mapleDbConnectionLayer } from "@maple/backend/platform/pg-connection-source"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import {
	forgetChatWorkspace,
	resolveChatWorkspace,
} from "@maple/backend/services/integrations/chat-workspace-rows"
import { resolveConnectorConfig } from "../config.ts"
import { relayInboundEvent, WorkspaceLookupFailed, type RelayPorts } from "./turn.ts"

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

export interface RelayHost {
	readonly env: Record<string, unknown>
	/** Whether this conversation has already been told that its workspace is not linked. */
	readonly announceUnlinked: Effect.Effect<boolean>
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

const ports = (
	host: RelayHost,
	connector: ChatConnector<HttpClient.HttpClient | ConnectorCredentials>,
): RelayPorts<HttpClient.HttpClient | ConnectorCredentials> => ({
	outbound: connector.outbound,
	resolveWorkspace: (connectorId, workspaceId) =>
		withDatabase(
			host.env,
			Effect.flatMap(Database, (database) => resolveChatWorkspace(database, connectorId, workspaceId)),
		).pipe(
			// Logged here, where the cause is, and re-raised as the relay's own failure: what the
			// relay must not do is mistake a database it could not read for a workspace nobody linked.
			Effect.catchCause((cause) =>
				Effect.logError("Chat workspace could not be resolved").pipe(
					Effect.annotateLogs({ "error.type": summarizeCause(cause) }),
					Effect.andThen(
						Effect.fail(
							new WorkspaceLookupFailed({
								connector: connectorId,
								message: "The chat workspace could not be read",
							}),
						),
					),
				),
			),
		),
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

	try {
		await Effect.runPromise(
			relayInboundEvent(event, ports(host, connector)).pipe(
				// oxlint-disable-next-line effecttsgo/strict-effect-provide
				Effect.provide(
					Layer.mergeAll(
						FetchHttpClient.layer,
						Layer.succeed(ConnectorCredentials)(config.config),
						workerEnvLayer(host.env),
						telemetry.layer,
					),
				),
			),
		)
	} finally {
		await telemetry.flush(host.env).catch(() => undefined)
	}
}
