import type { ChatOutboundError } from "@maple/chat-platform"
import {
	AlertDeliveryAuthError,
	AlertDeliveryError,
	AlertDeliveryRejectedError,
	AlertDeliveryTargetMissingError,
	AlertValidationError,
	type AlertDeliveryFailure,
	type AlertPersistenceError,
	type ChatConnectorId,
	type ChatWorkspaceId,
	type OrgId,
} from "@maple/domain/http"
import { Context, Duration, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import {
	ChatConnectorRegistry,
	chatOutboundTransport,
	loadOwnedChatWorkspace,
	missingOutboundConfig,
} from "@maple/backend/services/integrations/chat-outbound"
import { makePersistenceError } from "./alert-persistence"
import { AlertRuntime } from "./AlertRuntime"
import { failureForStatus } from "./delivery/runTransport"
import type { EffectTransportDeps } from "./delivery/Transport"

/*
 * The `chat` destination's two reaches into a linked workspace: posting an alert, and confirming
 * the channel a destination names is one the workspace's connector lists. Kept to `Database`,
 * `Env` and an HTTP client because the alerting Worker's bundle carries it, and that bundle is
 * size-constrained.
 */

/**
 * What the platform said, as the delivery queue's failure classes. The connector's `reason` is the
 * platform's own word where it gave one; otherwise the status decides, as it does for every HTTP
 * provider; with neither, the failure is worth retrying.
 */
export const chatDeliveryFailure = (error: ChatOutboundError): AlertDeliveryFailure => {
	const fields = {
		message: error.message,
		destinationType: "chat" as const,
		cause: error,
		...(error.status === undefined ? undefined : { providerStatus: error.status }),
	}
	switch (error.reason) {
		case "auth":
			return new AlertDeliveryAuthError(fields)
		case "not_found":
			return new AlertDeliveryTargetMissingError(fields)
		case "rejected":
			return new AlertDeliveryRejectedError(fields)
		case undefined:
			return error.status === undefined
				? new AlertDeliveryError(fields)
				: failureForStatus(error.status, { ...fields, providerStatus: error.status })
	}
}

/** A channel a `chat` destination may post to, as the workspace's connector names it. */
export interface ChatChannelChoice {
	readonly connector: ChatConnectorId
	readonly workspaceName: string
	readonly channelName: string
}

export interface ChatAlertPosterApi {
	readonly post: EffectTransportDeps["postChatAlert"]
	/**
	 * The channel, if the org's workspace lists it. What stops a destination naming a channel in
	 * somebody else's workspace: a connector with one deployment-wide credential would post there.
	 */
	readonly findChannel: (
		orgId: OrgId,
		workspaceId: ChatWorkspaceId,
		channelId: string,
	) => Effect.Effect<ChatChannelChoice, AlertValidationError | AlertPersistenceError>
}

const validation = (message: string, cause?: unknown) =>
	new AlertValidationError({ message, details: [], ...(cause === undefined ? undefined : { cause }) })

const make: Effect.Effect<ChatAlertPosterApi, never, Database | Env | HttpClient.HttpClient> = Effect.gen(
	function* () {
		const database = yield* Database
		const env = yield* Env
		const httpClient = yield* HttpClient.HttpClient
		const registry = yield* ChatConnectorRegistry
		const runtime = yield* AlertRuntime
		const outboundConfig = env.CHAT_CONNECTOR_OUTBOUND_CONFIG

		// Held as an Option rather than failing the layer: the services this sits beside already
		// refuse to boot on a bad key, so this is never the first to notice.
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => message,
		).pipe(Effect.option)

		const deliveryError = (message: string, cause?: unknown) =>
			new AlertDeliveryError({
				message,
				destinationType: "chat",
				...(cause === undefined ? undefined : { cause }),
			})

		const post: ChatAlertPosterApi["post"] = Effect.fn("AlertDelivery.chat")(
			function* (request) {
				yield* Effect.annotateCurrentSpan({
					orgId: request.orgId,
					"maple.delivery.destination_type": "chat",
				})
				if (Option.isNone(encryptionKey)) {
					return yield* deliveryError(
						"MAPLE_INGEST_KEY_ENCRYPTION_KEY is unusable on this deployment",
					)
				}
				const workspace = yield* loadOwnedChatWorkspace(
					database,
					registry,
					request.orgId,
					request.workspaceId,
					encryptionKey.value,
				).pipe(
					Effect.catchTags({
						// A failed LOOKUP is not a missing workspace: keep it retryable.
						"@maple/api/lib/DatabaseError": (cause) =>
							Effect.fail(deliveryError("Failed to load the chat workspace", cause)),
						// Only a reinstall writes a credential that opens.
						"@maple/backend/ChatWorkspaceCredentialsUnreadable": (cause) =>
							Effect.fail(
								new AlertDeliveryAuthError({
									message:
										"The chat workspace's stored credential is unreadable — reinstall the app to relink it",
									destinationType: "chat",
									cause,
								}),
							),
					}),
				)
				if (Option.isNone(workspace)) {
					return yield* new AlertDeliveryTargetMissingError({
						message:
							"The chat workspace was unlinked — point this destination at another channel",
						destinationType: "chat",
					})
				}
				const { connector, externalWorkspaceId } = workspace.value
				yield* Effect.annotateCurrentSpan({ "chat.connector": connector.id })
				// A deployment gap, not the org's: retryable, so no destination is disabled for it.
				const missing = missingOutboundConfig(workspace.value, outboundConfig)
				if (missing.length > 0) {
					return yield* deliveryError(
						`${connector.manifest.name} is not configured on this deployment (${missing.join(", ")})`,
					)
				}
				const transport = yield* chatOutboundTransport(workspace.value, outboundConfig, httpClient)
				const posted = yield* transport
					.post({ workspaceId: externalWorkspaceId, channelId: request.channelId }, request.blocks)
					.pipe(
						Effect.mapError(chatDeliveryFailure),
						Effect.timeoutOrElse({
							duration: Duration.millis(runtime.deliveryTimeoutMs()),
							orElse: () =>
								Effect.fail(
									deliveryError(
										`${connector.manifest.name} delivery timed out after ${runtime.deliveryTimeoutMs()}ms`,
									),
								),
						}),
					)
				return { connectorName: connector.manifest.name, messageId: posted.messageId }
			},
			// Every failure, the ones before the post included: a flat rate of one tag is one
			// broken destination, and the span is where that is read.
			Effect.tapError((failure) =>
				Effect.annotateCurrentSpan({
					"maple.delivery.failure_tag": failure._tag,
					"maple.delivery.retryable": failure.error.retryable,
				}),
			),
		)

		const findChannel: ChatAlertPosterApi["findChannel"] = Effect.fn("ChatAlertPoster.findChannel")(
			function* (orgId, workspaceId, channelId) {
				if (Option.isNone(encryptionKey)) {
					return yield* validation("Chat workspaces cannot be read on this deployment")
				}
				const workspace = yield* loadOwnedChatWorkspace(
					database,
					registry,
					orgId,
					workspaceId,
					encryptionKey.value,
				).pipe(
					Effect.catchTags({
						"@maple/api/lib/DatabaseError": (cause) => Effect.fail(makePersistenceError(cause)),
						"@maple/backend/ChatWorkspaceCredentialsUnreadable": (cause) =>
							Effect.fail(
								validation(
									"This chat workspace's stored credential is unreadable — reinstall the app to relink it",
									cause,
								),
							),
					}),
				)
				// Another org's workspace reads exactly like one that does not exist.
				if (Option.isNone(workspace)) {
					return yield* validation("That chat workspace is not linked to this organization")
				}
				const { connector, externalWorkspaceId, name } = workspace.value
				if (missingOutboundConfig(workspace.value, outboundConfig).length > 0) {
					return yield* validation(
						`${connector.manifest.name} is not configured on this deployment`,
					)
				}
				const transport = yield* chatOutboundTransport(workspace.value, outboundConfig, httpClient)
				const channels = yield* transport
					.destinations(externalWorkspaceId)
					.pipe(
						Effect.mapError((cause) =>
							validation(
								`Couldn't list this workspace's ${connector.manifest.name} channels: ${cause.message}`,
								cause,
							),
						),
					)
				const channel = channels.find((candidate) => candidate.id === channelId)
				if (channel === undefined) {
					return yield* validation(
						"That channel is not one the Maple bot can post to in this workspace",
					)
				}
				return { connector: connector.id, workspaceName: name, channelName: channel.name }
			},
		)

		return { post, findChannel }
	},
)

export class ChatAlertPoster extends Context.Service<ChatAlertPoster, ChatAlertPosterApi>()(
	"@maple/api/services/ChatAlertPoster",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
