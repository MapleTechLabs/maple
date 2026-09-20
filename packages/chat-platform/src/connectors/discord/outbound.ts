/**
 * Discord's outbound half: REST v10 over Effect's `HttpClient`.
 *
 * The bot token arrives as a service the host Worker supplies — this package never reads an
 * environment — and every request is a `Client`-kind span with `peer.service`, the same treatment
 * alert delivery gives its providers, so the dependency is visible on the service map.
 *
 * Checked against Discord's REST documentation for API v10: create is
 * `POST /channels/{id}/messages`, edit is `PATCH /channels/{id}/messages/{id}`, typing is
 * `POST /channels/{id}/typing` and expires after ten seconds, and a 429 answers with
 * `retry_after` in SECONDS (fractional).
 */
import { Context, Duration, Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import {
	ChatOutboundError,
	type ChatMessageRef,
	type ChatOutbound,
	type ChatOutboundOperation,
	type ChatTarget,
} from "../../outbound"
import type { ChatBlock } from "../../render/blocks"
import { DISCORD_CONNECTOR_ID } from "./id"
import { renderDiscordMessage } from "./render"

/** The credential the host Worker holds for this connector. */
export class DiscordBotToken extends Context.Service<DiscordBotToken, Redacted.Redacted<string>>()(
	"@maple/chat-platform/connectors/discord/BotToken",
) {}

const API_BASE = "https://discord.com/api/v10"

/**
 * 2000 is Discord's hard limit on `content`; the neutral cut is held to less so a connector's own
 * decoration — link syntax, quote markers, an approval's label — has somewhere to go.
 */
const MAX_MESSAGE_CHARS = 1800

/**
 * Discord's per-channel message rate is five in five seconds, shared with every other bot in the
 * channel. Editing a streaming turn twice a second leaves room for that and still reads as live.
 */
const MIN_EDIT_INTERVAL = Duration.millis(500)

/** How many times a 429 is waited out before the turn gives up on the message. */
const MAX_RATE_LIMIT_ATTEMPTS = 3

/** What Discord answers a create with; the edit and typing bodies are not read. */
const CreatedMessage = Schema.Struct({
	id: Schema.String,
	channel_id: Schema.String,
})

const RateLimited = Schema.Struct({
	/** Seconds, fractional. */
	retry_after: Schema.Finite,
})

export const discordOutbound: ChatOutbound<HttpClient.HttpClient | DiscordBotToken> = {
	limits: { maxMessageChars: MAX_MESSAGE_CHARS, minEditInterval: MIN_EDIT_INTERVAL },
	transport: Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const token = yield* DiscordBotToken
		const authorized = (request: HttpClientRequest.HttpClientRequest) =>
			HttpClientRequest.setHeader(request, "authorization", `Bot ${Redacted.value(token)}`)

		const send = (
			operation: ChatOutboundOperation,
			request: HttpClientRequest.HttpClientRequest,
			attempt: number,
		): Effect.Effect<HttpClientResponse.HttpClientResponse, ChatOutboundError> =>
			Effect.gen(function* () {
				const response = yield* client
					.execute(authorized(request))
					.pipe(Effect.mapError((cause) => failed(operation, "Discord was unreachable", { cause })))
				if (response.status === 429 && attempt < MAX_RATE_LIMIT_ATTEMPTS) {
					yield* Effect.sleep(yield* retryAfter(response))
					return yield* send(operation, request, attempt + 1)
				}
				if (response.status >= 300) {
					return yield* failed(operation, `Discord answered ${response.status}`, {
						status: response.status,
					})
				}
				return response
			}).pipe(
				Effect.withSpan(`Discord.${operation}`, {
					kind: "client",
					attributes: { "peer.service": "discord" },
				}),
			)

		const body = (blocks: ReadonlyArray<ChatBlock>, extra?: Record<string, unknown>) =>
			HttpClientRequest.bodyJsonUnsafe({ ...renderDiscordMessage(blocks), ...extra })

		return {
			post: (target: ChatTarget, blocks: ReadonlyArray<ChatBlock>) =>
				Effect.gen(function* () {
					const response = yield* send(
						"post",
						HttpClientRequest.post(`${API_BASE}/channels/${target.conversationId}/messages`).pipe(
							body(blocks, reference(target)),
						),
						0,
					)
					const json = yield* response.json.pipe(
						Effect.mapError((cause) =>
							failed("post", "Discord's reply could not be read", { cause }),
						),
					)
					const created = yield* Schema.decodeUnknownEffect(CreatedMessage)(json).pipe(
						Effect.mapError((cause) =>
							failed("post", "Discord answered with no message id", { cause }),
						),
					)
					return { conversationId: created.channel_id, messageId: created.id }
				}),

			edit: (ref: ChatMessageRef, blocks: ReadonlyArray<ChatBlock>) =>
				send(
					"edit",
					HttpClientRequest.patch(
						`${API_BASE}/channels/${ref.conversationId}/messages/${ref.messageId}`,
					).pipe(body(blocks)),
					0,
				).pipe(Effect.asVoid),

			typing: (target: ChatTarget) =>
				send(
					"typing",
					HttpClientRequest.post(`${API_BASE}/channels/${target.conversationId}/typing`),
					0,
				).pipe(Effect.asVoid),
		}
	}),
}

/**
 * `fail_if_not_exists: false` keeps a turn from being lost when the message it answers was deleted
 * while the agent was thinking — Discord would otherwise reject the whole post.
 */
const reference = (target: ChatTarget) =>
	target.replyToMessageId === undefined
		? undefined
		: { message_reference: { message_id: target.replyToMessageId, fail_if_not_exists: false } }

const failed = (
	operation: ChatOutboundOperation,
	message: string,
	extra: { readonly status?: number; readonly cause?: unknown },
) => new ChatOutboundError({ message, connectorId: DISCORD_CONNECTOR_ID, operation, ...extra })

/**
 * How long Discord asked us to wait. The JSON body is the documented source; the `retry-after`
 * header is the fallback for a 429 served by the edge rather than the API.
 */
const retryAfter = (response: HttpClientResponse.HttpClientResponse) =>
	response.json.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(RateLimited)),
		Effect.map((limited) => Duration.seconds(limited.retry_after)),
		Effect.orElseSucceed(() => headerRetryAfter(response)),
	)

const DEFAULT_RETRY_AFTER = Duration.seconds(1)

const headerRetryAfter = (response: HttpClientResponse.HttpClientResponse): Duration.Duration => {
	const header = response.headers["retry-after"]
	const seconds = header === undefined ? Number.NaN : Number.parseFloat(header)
	return Number.isFinite(seconds) ? Duration.seconds(seconds) : DEFAULT_RETRY_AFTER
}
