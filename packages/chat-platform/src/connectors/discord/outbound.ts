/**
 * Discord's outbound half: REST v10 over Effect's `HttpClient`.
 *
 * The bot token arrives as a service the host Worker supplies — this package never reads an
 * environment — and every attempt is a `Client`-kind span carrying `peer.service` and the request's
 * route, the same treatment alert delivery gives its providers, so the dependency is visible on the
 * service map. The route is a TEMPLATE, never the concrete path: a channel and a message id are
 * high-cardinality and one of them names the conversation.
 *
 * Checked against Discord's REST documentation for API v10: create is
 * `POST /channels/{id}/messages`, edit is `PATCH /channels/{id}/messages/{id}`, typing is
 * `POST /channels/{id}/typing` and expires after ten seconds, a thread is
 * `POST /channels/{id}/messages/{id}/threads` with a 1–100 character name and an
 * `auto_archive_duration` of 60, 1440, 4320 or 10080 minutes, and a 429 answers with `retry_after`
 * in SECONDS (fractional).
 *
 * A Discord thread IS a channel, so once a turn is answering in one every call addresses the
 * thread's id — which is why the target's channel is resolved through {@link channelOf} rather
 * than read directly.
 */
import { Context, Duration, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import {
	ChatOutboundError,
	type ChatMessageRef,
	type ChatOutbound,
	type ChatOutboundOperation,
	type ChatTarget,
	type ChatThreadRequest,
} from "../../outbound"
import type { ChatBlock } from "../../render/blocks"
import { DISCORD_CONNECTOR_ID } from "./id"
import { renderDiscordMessage } from "./render"

/** The credential the host Worker holds for this connector. */
export class DiscordBotToken extends Context.Service<DiscordBotToken, Redacted.Redacted<string>>()(
	"@maple/chat-platform/connectors/discord/BotToken",
) {}

const API_BASE = "https://discord.com/api/v10"
const API_HOST = "discord.com"

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

/**
 * The longest a 429 may park a turn.
 *
 * `retry_after` is a remote number reaching `Effect.sleep`: a global limit can legitimately ask for
 * minutes, and a wrong or hostile value would pin the fiber for as long as it says. Waiting the
 * ceiling and trying again costs one attempt; obeying an unbounded value costs the turn.
 */
const MAX_RETRY_AFTER = Duration.seconds(30)

const DEFAULT_RETRY_AFTER = Duration.seconds(1)

/** Past an hour the value is not a rate limit, it is a bad number; fall through to the default. */
const MAX_RETRY_AFTER_SECONDS = 3600

/** What Discord answers a create with; the edit and typing bodies are not read. */
const CreatedMessage = Schema.Struct({
	id: Schema.String,
	channel_id: Schema.String,
})

/** A started thread is a channel, and its id is what every later call addresses. */
const CreatedThread = Schema.Struct({ id: Schema.String })

/** 1–100 characters, per the Start Thread documentation. */
const MAX_THREAD_NAME_CHARS = 100

/** A day of quiet before the thread leaves the channel list. Long enough to come back to an answer. */
const THREAD_ARCHIVE_MINUTES = 1440

/** The thread when the turn is in one, the channel otherwise — on Discord both are channel ids. */
const channelOf = (target: ChatTarget): string => target.threadId ?? target.channelId

/** Seconds, fractional. Anything outside the window falls through to the header and the default. */
const RETRY_AFTER_SECONDS = Schema.Finite.pipe(
	Schema.check(Schema.isBetween({ minimum: 0, maximum: MAX_RETRY_AFTER_SECONDS })),
)

const RateLimited = Schema.Struct({ retry_after: RETRY_AFTER_SECONDS })

const decodeHeaderRetryAfter = Schema.decodeUnknownOption(
	Schema.FiniteFromString.pipe(
		Schema.check(Schema.isBetween({ minimum: 0, maximum: MAX_RETRY_AFTER_SECONDS })),
	),
)

/** Internal to the retry loop: a 429 and how long it asked for. Never leaves this module. */
class DiscordRateLimited extends Schema.TaggedError<DiscordRateLimited>()(
	"@maple/chat-platform/connectors/discord/RateLimited",
	{ wait: Schema.Duration },
) {}

export const discordOutbound: ChatOutbound<HttpClient.HttpClient | DiscordBotToken> = {
	connectorId: DISCORD_CONNECTOR_ID,
	limits: { maxMessageChars: MAX_MESSAGE_CHARS, minEditInterval: MIN_EDIT_INTERVAL },
	transport: Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const token = yield* DiscordBotToken

		/**
		 * One HTTP attempt, as one client span.
		 *
		 * A 429 fails with {@link DiscordRateLimited} rather than being retried in here, so the
		 * attempts a rate limit costs are sibling spans that each record their own status, instead of
		 * nesting three deep under the first one.
		 */
		const attempt = Effect.fn("Discord.request", { kind: "client" })(function* (
			operation: ChatOutboundOperation,
			route: string,
			request: HttpClientRequest.HttpClientRequest,
		) {
			yield* Effect.annotateCurrentSpan({
				"peer.service": "discord",
				"http.request.method": request.method,
				"server.address": API_HOST,
				// The template, not the path: a channel id names the conversation and a message id is
				// unbounded cardinality.
				"url.template": route,
			})
			const response = yield* client
				.execute(
					HttpClientRequest.setHeader(request, "authorization", `Bot ${Redacted.value(token)}`),
				)
				.pipe(
					// The reason matters: an encode or invalid-url failure is Maple's own bug, and
					// collapsing it into "Discord was unreachable" files it forever as Discord's.
					Effect.mapError((cause) =>
						failed(operation, `Discord request failed (${cause.reason._tag})`, { cause }),
					),
				)
			yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
			if (response.status === 429)
				return yield* new DiscordRateLimited({ wait: yield* retryAfter(response) })
			if (response.status >= 300) {
				return yield* failed(operation, `Discord answered ${response.status}`, {
					status: response.status,
				})
			}
			return response
		})

		const send = (
			operation: ChatOutboundOperation,
			route: string,
			request: HttpClientRequest.HttpClientRequest,
		): Effect.Effect<HttpClientResponse.HttpClientResponse, ChatOutboundError> => {
			const tryOnce = (
				count: number,
			): Effect.Effect<HttpClientResponse.HttpClientResponse, ChatOutboundError> =>
				attempt(operation, route, request).pipe(
					Effect.catchTag("@maple/chat-platform/connectors/discord/RateLimited", (limited) =>
						count >= MAX_RATE_LIMIT_ATTEMPTS
							? Effect.fail(
									failed(operation, "Discord kept rate limiting this message", {
										status: 429,
									}),
								)
							: Effect.sleep(limited.wait).pipe(Effect.andThen(tryOnce(count + 1))),
					),
				)
			return tryOnce(1)
		}

		const body = (blocks: ReadonlyArray<ChatBlock>) =>
			HttpClientRequest.bodyJsonUnsafe(renderDiscordMessage(blocks))

		return {
			post: Effect.fn("Discord.post")(function* (target: ChatTarget, blocks: ReadonlyArray<ChatBlock>) {
				const response = yield* send(
					"post",
					"/channels/{channel_id}/messages",
					HttpClientRequest.post(`${API_BASE}/channels/${channelOf(target)}/messages`).pipe(
						body(blocks),
					),
				)
				// Inside the span, so a reply we cannot read fails the operation rather than leaving an
				// Ok span beside a failed turn.
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
				return { target, messageId: created.id }
			}),

			edit: (ref: ChatMessageRef, blocks: ReadonlyArray<ChatBlock>) =>
				send(
					"edit",
					"/channels/{channel_id}/messages/{message_id}",
					HttpClientRequest.patch(
						`${API_BASE}/channels/${channelOf(ref.target)}/messages/${ref.messageId}`,
					).pipe(body(blocks)),
				).pipe(Effect.asVoid),

			typing: (target: ChatTarget) =>
				send(
					"typing",
					"/channels/{channel_id}/typing",
					HttpClientRequest.post(`${API_BASE}/channels/${channelOf(target)}/typing`),
				).pipe(Effect.asVoid),

			openThread: Effect.fn("Discord.openThread")(function* (request: ChatThreadRequest) {
				const response = yield* send(
					"thread",
					"/channels/{channel_id}/messages/{message_id}/threads",
					HttpClientRequest.post(
						`${API_BASE}/channels/${request.channelId}/messages/${request.anchorMessageId}/threads`,
					).pipe(
						HttpClientRequest.bodyJsonUnsafe({
							name: request.title.slice(0, MAX_THREAD_NAME_CHARS),
							auto_archive_duration: THREAD_ARCHIVE_MINUTES,
						}),
					),
				)
				const json = yield* response.json.pipe(
					Effect.mapError((cause) =>
						failed("thread", "Discord's reply could not be read", { cause }),
					),
				)
				const thread = yield* Schema.decodeUnknownEffect(CreatedThread)(json).pipe(
					Effect.mapError((cause) =>
						failed("thread", "Discord answered with no thread id", { cause }),
					),
				)
				return thread.id
			}),
		}
	}),
}

const failed = (
	operation: ChatOutboundOperation,
	message: string,
	extra: { readonly status?: number; readonly cause?: unknown },
) => new ChatOutboundError({ message, connectorId: DISCORD_CONNECTOR_ID, operation, ...extra })

/**
 * How long Discord asked us to wait, clamped. The JSON body is the documented source; the
 * `retry-after` header is the fallback for a 429 served by the edge rather than by the API.
 */
const retryAfter = (response: HttpClientResponse.HttpClientResponse) =>
	response.json.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(RateLimited)),
		Effect.map((limited) => Duration.seconds(limited.retry_after)),
		Effect.orElseSucceed(() => headerRetryAfter(response)),
		Effect.map(Duration.min(MAX_RETRY_AFTER)),
	)

const headerRetryAfter = (response: HttpClientResponse.HttpClientResponse): Duration.Duration => {
	const seconds = decodeHeaderRetryAfter(response.headers["retry-after"])
	return Option.isSome(seconds) ? Duration.seconds(seconds.value) : DEFAULT_RETRY_AFTER
}
