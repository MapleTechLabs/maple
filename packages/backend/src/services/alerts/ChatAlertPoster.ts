import type { ChatBlock, ChatOutboundError, ChatOutboundTransport, ChatTarget } from "@maple/chat-platform"
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
import { Context, Duration, Effect, Layer, Option, Redacted, Ref, Array as Arr } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
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
import type { ChatAlertPosted, EffectTransportDeps } from "./delivery/Transport"

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

/** A page to one person: a direct message to the chat account they linked. */
export interface ChatDirectAlertPost {
	readonly orgId: OrgId
	/** The `chat_workspaces` row id the message goes out through. */
	readonly workspaceId: ChatWorkspaceId
	/** The platform's own id for the person's account. */
	readonly externalUserId: string
	readonly blocks: ReadonlyArray<ChatBlock>
}

export interface ChatAlertPosterApi {
	readonly post: EffectTransportDeps["postChatAlert"]
	readonly postDirect: (post: ChatDirectAlertPost) => Effect.Effect<ChatAlertPosted, AlertDeliveryFailure>
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

/**
 * The message with its chart images dropped. The platform fetches an image at post time and refuses
 * the whole message when it cannot, so a rejected post with an image is retried once without it.
 */
const withoutImages = (blocks: ReadonlyArray<ChatBlock>): ReadonlyArray<ChatBlock> | undefined =>
	Arr.some(blocks, (block) => (block.kind === "alert" || block.kind === "chart") && block.imageUrl !== null)
		? Arr.map(blocks, (block) =>
				block.kind === "alert" || block.kind === "chart" ? { ...block, imageUrl: null } : block,
			)
		: undefined

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
		// One transport per linked workspace, so a burst of alerts to one channel shares the
		// connector's rate-limit buckets and queue instead of each post starting blind.
		const transports = yield* Ref.make(new Map<string, ChatOutboundTransport>())

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

		/** Posts `blocks` through the org's workspace, to the target `targetOf` names on it. */
		const deliver = Effect.fnUntraced(function* (
			request: {
				readonly orgId: OrgId
				readonly workspaceId: ChatWorkspaceId
				readonly blocks: ReadonlyArray<ChatBlock>
			},
			targetOf: (
				transport: ChatOutboundTransport,
				externalWorkspaceId: string,
			) => Effect.Effect<ChatTarget, ChatOutboundError>,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId: request.orgId,
				"maple.delivery.destination_type": "chat",
			})
			if (Option.isNone(encryptionKey)) {
				return yield* deliveryError("MAPLE_INGEST_KEY_ENCRYPTION_KEY is unusable on this deployment")
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
					"@maple/backend/lib/DatabaseError": (cause) =>
						Effect.fail(deliveryError("Failed to load the chat workspace", cause)),
					// Maple could not open its own stored credential (for example after a
					// key rotation): retryable, so no destination is disabled for it.
					"@maple/backend/ChatWorkspaceCredentialsUnreadable": (cause) =>
						Effect.fail(
							deliveryError(
								"The chat workspace's stored credential is unreadable. Reinstall the app to relink it",
								cause,
							),
						),
				}),
			)
			if (Option.isNone(workspace)) {
				return yield* new AlertDeliveryTargetMissingError({
					message:
						"The chat workspace was unlinked. Link it again, or point this destination at another channel",
					destinationType: "chat",
				})
			}
			const { connector, externalWorkspaceId } = workspace.value
			yield* Effect.annotateCurrentSpan({ "maple.chat.connector": connector.id })
			// A deployment gap, not the org's: retryable, so no destination is disabled for it.
			const missing = missingOutboundConfig(workspace.value, outboundConfig)
			if (missing.length > 0) {
				return yield* deliveryError(
					`${connector.manifest.name} is not configured on this deployment (${Arr.join(missing, ", ")})`,
				)
			}
			const transportKey = `${connector.id}\u0000${externalWorkspaceId}\u0000${workspace.value.credentials ?? ""}`
			const cached = (yield* Ref.get(transports)).get(transportKey)
			const transport =
				cached ?? (yield* chatOutboundTransport(workspace.value, outboundConfig, httpClient))
			if (cached === undefined)
				yield* Ref.update(transports, (map) => new Map(map).set(transportKey, transport))
			const imageless = withoutImages(request.blocks)
			const posted = yield* targetOf(transport, externalWorkspaceId).pipe(
				Effect.flatMap((target) =>
					transport.post(target, request.blocks).pipe(
						Effect.catchIf(
							(error) => error.reason === "rejected",
							(error) =>
								imageless === undefined
									? Effect.fail(error)
									: Effect.logWarning(
											"Chat alert rejected with its chart image; posting it without",
										).pipe(
											Effect.annotateLogs({
												"maple.chat.connector": connector.id,
												error: error.message,
											}),
											Effect.andThen(
												Effect.annotateCurrentSpan(
													"maple.delivery.image_dropped",
													true,
												),
											),
											Effect.andThen(transport.post(target, imageless)),
										),
						),
					),
				),
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
			return {
				connectorName: connector.manifest.name,
				messageId: posted.messageId,
			} satisfies ChatAlertPosted
		})

		// Every failure, the ones before the post included: a flat rate of one tag is one
		// broken destination, and the span is where that is read.
		const tagFailure = <A, R>(self: Effect.Effect<A, AlertDeliveryFailure, R>) =>
			self.pipe(
				Effect.tapError((failure) =>
					Effect.annotateCurrentSpan({
						"maple.delivery.failure_tag": failure._tag,
						"maple.delivery.retryable": failure.error.retryable,
					}),
				),
			)

		const post: ChatAlertPosterApi["post"] = Effect.fn("AlertDelivery.chat")(function* (request) {
			return yield* deliver(request, (_transport, externalWorkspaceId) =>
				Effect.succeed({ workspaceId: externalWorkspaceId, channelId: request.channelId }),
			)
		}, tagFailure)

		const postDirect: ChatAlertPosterApi["postDirect"] = Effect.fn("AlertDelivery.chatDirect")(function* (
			request,
		) {
			return yield* deliver(request, (transport, externalWorkspaceId) =>
				transport.directMessage(externalWorkspaceId, request.externalUserId),
			)
		}, tagFailure)

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
						"@maple/backend/lib/DatabaseError": (cause) =>
							Effect.fail(makePersistenceError(cause)),
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
				const found = Arr.findFirst(channels, (candidate) => candidate.id === channelId)
				if (Option.isNone(found)) {
					return yield* validation(
						"That channel is not one the Maple bot can post to in this workspace",
					)
				}
				return { connector: connector.id, workspaceName: name, channelName: found.value.name }
			},
		)

		return { post, postDirect, findChannel }
	},
)

export class ChatAlertPoster extends Context.Service<ChatAlertPoster, ChatAlertPosterApi>()(
	"@maple/backend/services/ChatAlertPoster",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
