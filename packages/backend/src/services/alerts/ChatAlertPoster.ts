import type { ChatOutboundError } from "@maple/chat-platform"
import {
	AlertDeliveryAuthError,
	AlertDeliveryError,
	AlertDeliveryRejectedError,
	AlertDeliveryTargetMissingError,
	type AlertDeliveryFailure,
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
} from "@maple/backend/services/integrations/chat-outbound"
import { AlertRuntime } from "./AlertRuntime"
import { failureForStatus } from "./delivery/runTransport"
import type { EffectTransportDeps } from "./delivery/Transport"

/*
 * The `chat` destination's delivery: a linked workspace's connector, posting one alert. Kept to
 * `Database`, `Env` and an HTTP client because the alerting Worker's bundle carries it, and that
 * bundle is size-constrained.
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
				? new AlertDeliveryError({ ...fields, cause: error })
				: failureForStatus(error.status, { ...fields, providerStatus: error.status })
	}
}

export interface ChatAlertPosterApi {
	readonly post: EffectTransportDeps["postChatAlert"]
}

const make: Effect.Effect<ChatAlertPosterApi, never, Database | Env | HttpClient.HttpClient> = Effect.gen(
	function* () {
		const database = yield* Database
		const env = yield* Env
		const httpClient = yield* HttpClient.HttpClient
		const registry = yield* ChatConnectorRegistry
		const runtime = yield* AlertRuntime

		// Per post rather than at layer build: the services this sits beside already refuse to boot
		// on a bad key, so this is never the first to notice.
		const encryptionKey = parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) =>
				new AlertDeliveryError({
					message: `MAPLE_INGEST_KEY_ENCRYPTION_KEY: ${message}`,
					destinationType: "chat",
				}),
		)

		const post: ChatAlertPosterApi["post"] = Effect.fn("AlertDelivery.chat")(function* (request) {
			yield* Effect.annotateCurrentSpan({
				orgId: request.orgId,
				"maple.delivery.destination_type": "chat",
			})
			const workspace = yield* loadOwnedChatWorkspace(
				database,
				registry,
				request.orgId,
				request.workspaceId,
				yield* encryptionKey,
			).pipe(
				// A failed LOOKUP is not a missing workspace: keep it retryable.
				Effect.mapError(
					(cause) =>
						new AlertDeliveryError({
							message: "Failed to load the chat workspace",
							destinationType: "chat",
							cause,
						}),
				),
			)
			if (Option.isNone(workspace)) {
				return yield* new AlertDeliveryTargetMissingError({
					message: "The chat workspace was unlinked — point this destination at another channel",
					destinationType: "chat",
				})
			}
			const { connector, externalWorkspaceId } = workspace.value
			yield* Effect.annotateCurrentSpan({
				"peer.service": connector.id,
				"chat.connector": connector.id,
			})
			const transport = yield* chatOutboundTransport(
				workspace.value,
				env.CHAT_CONNECTOR_OUTBOUND_CONFIG,
				httpClient,
			)
			const posted = yield* transport
				.post({ workspaceId: externalWorkspaceId, channelId: request.channelId }, request.blocks)
				.pipe(
					Effect.mapError(chatDeliveryFailure),
					Effect.timeoutOrElse({
						duration: Duration.millis(runtime.deliveryTimeoutMs()),
						orElse: () =>
							Effect.fail(
								new AlertDeliveryError({
									message: `${connector.manifest.name} delivery timed out after ${runtime.deliveryTimeoutMs()}ms`,
									destinationType: "chat",
								}),
							),
					}),
					Effect.tapError((failure) =>
						Effect.annotateCurrentSpan({
							"maple.delivery.failure_tag": failure._tag,
							"maple.delivery.retryable": failure.error.retryable,
						}),
					),
				)
			return { connectorName: connector.manifest.name, messageId: posted.messageId }
		})

		return { post }
	},
)

export class ChatAlertPoster extends Context.Service<ChatAlertPoster, ChatAlertPosterApi>()(
	"@maple/api/services/ChatAlertPoster",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
