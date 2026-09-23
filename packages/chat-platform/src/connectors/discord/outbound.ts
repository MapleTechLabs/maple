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
import { ChatConversationKey } from "@maple/primitives"
import { Array as Arr, Duration, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import type { ConnectorConfig, InboundAction, InboundMessage } from "../../ingress"
import {
	ChatOutboundError,
	ConnectorCredentials,
	type ChatConversation,
	type ChatHistoryMessage,
	type ChatMessageRef,
	type ChatOutbound,
	type ChatOutboundOperation,
	type ChatTarget,
	type ChatThreadRequest,
} from "../../outbound"
import type { ChatBlock } from "../../render/blocks"
import { API_BASE, API_HOST, BOT_TOKEN_CONFIG } from "./api"
import { User } from "./gateway-payloads"
import { DISCORD_CONNECTOR_ID } from "./id"
import { renderDiscordMessage } from "./render"

/**
 * The bot token out of the configuration the host resolved.
 *
 * `BOT_TOKEN_CONFIG` (`./api.ts`) is also what the gateway half declares in its `requiredConfig`,
 * so one secret under one name serves both halves — and the host, which skips a connector whose
 * declared configuration is missing, is what makes the fallback here unreachable rather than a
 * silent unauthenticated mode.
 */
const botToken = (config: ConnectorConfig): Redacted.Redacted<string> =>
	Redacted.make(config.get(BOT_TOKEN_CONFIG) ?? "")

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

/**
 * One earlier message, as `GET /channels/{id}/messages` answers it.
 *
 * `content` is empty for a message that carries no text of its own, and for every message the
 * application is not allowed to read — the message-content grant governs this REST reply exactly
 * as it governs the gateway. The user shape is the gateway half's, so the two readings of a
 * Discord message object cannot drift apart.
 */
const HistoryMessage = Schema.Struct({
	author: User,
	member: Schema.optionalKey(Schema.Struct({ nick: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
	content: Schema.String,
	/** ISO-8601. A value that will not parse leaves the message out rather than dating it to 1970. */
	timestamp: Schema.String,
	webhook_id: Schema.optionalKey(Schema.String),
})

const decodeHistoryMessage = Schema.decodeUnknownOption(HistoryMessage)

/**
 * One earlier message as the contract carries it, or nothing at all.
 *
 * Per message rather than per page, and deliberately: a page is CONTEXT, and one message this
 * connector cannot read — a type Discord added, a field that started arriving `null` — is not worth
 * losing the conversation around it for. The gateway half drops an unreadable payload the same way.
 */
const historyMessage = (raw: unknown): Option.Option<ChatHistoryMessage> =>
	Option.flatMap(decodeHistoryMessage(raw), (message) => {
		const at = Date.parse(message.timestamp)
		if (Number.isNaN(at)) return Option.none()
		return Option.some({
			displayName: message.member?.nick ?? message.author.global_name ?? message.author.username,
			isBot: message.author.bot === true || message.webhook_id !== undefined,
			text: message.content,
			at,
		})
	})

/** Discord's own ceiling on one page of history. */
const MAX_HISTORY_LIMIT = 100

/** 1–100 characters, per the Start Thread documentation. */
const MAX_THREAD_NAME_CHARS = 100

/** What a thread is called when the caller had nothing to call it. */
const DEFAULT_THREAD_NAME = "Maple"

/**
 * A name Discord will accept. The ceiling is the documented 100; the FLOOR is the point — the
 * limit is 1–100, and a caller that truncated an empty question down to nothing would otherwise
 * turn the thread into a 400 and the answer into no answer at all.
 */
const threadName = (title: string): string => {
	const trimmed = title.trim().slice(0, MAX_THREAD_NAME_CHARS)
	return trimmed.length === 0 ? DEFAULT_THREAD_NAME : trimmed
}

/** A day of quiet before the thread leaves the channel list. Long enough to come back to an answer. */
const THREAD_ARCHIVE_MINUTES = 1440

/** The thread when the turn is in one, the channel otherwise — on Discord both are channel ids. */
const channelOf = (target: ChatTarget): string => target.threadId ?? target.channelId

/**
 * Every id Discord mints is a snowflake, which the key's charset covers — but the id came off the
 * wire, so it is decoded rather than branded, and an id that is not one fails the turn instead of
 * escaping the transport as a defect.
 */
const decodeConversationKey = Schema.decodeUnknownOption(ChatConversationKey)

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

export const discordOutbound: ChatOutbound<HttpClient.HttpClient | ConnectorCredentials> = {
	connectorId: DISCORD_CONNECTOR_ID,
	limits: { maxMessageChars: MAX_MESSAGE_CHARS, minEditInterval: MIN_EDIT_INTERVAL },
	transport: Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		// Per call, not here: acquiring the transport must not cost the host its credential read.
		const token = Effect.map(yield* ConnectorCredentials, botToken)

		/**
		 * One HTTP attempt, as one client span.
		 *
		 * A 429 fails with {@link DiscordRateLimited} rather than being retried in here, so the
		 * attempts a rate limit costs are sibling spans that each record their own status, instead of
		 * nesting three deep under the first one.
		 */
		const attempt = Effect.fn("Discord.request", { kind: "client" })(function* (
			bearer: Redacted.Redacted<string>,
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
					HttpClientRequest.setHeader(request, "authorization", `Bot ${Redacted.value(bearer)}`),
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
		): Effect.Effect<HttpClientResponse.HttpClientResponse, ChatOutboundError> =>
			Effect.flatMap(token, (bearer) => {
				const tryOnce = (
					count: number,
				): Effect.Effect<HttpClientResponse.HttpClientResponse, ChatOutboundError> =>
					attempt(bearer, operation, route, request).pipe(
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
			})

		const body = (blocks: ReadonlyArray<ChatBlock>) =>
			HttpClientRequest.bodyJsonUnsafe(renderDiscordMessage(blocks))

		const openThread = Effect.fn("Discord.openThread")(function* (request: ChatThreadRequest) {
			const response = yield* send(
				"thread",
				"/channels/{channel_id}/messages/{message_id}/threads",
				HttpClientRequest.post(
					`${API_BASE}/channels/${request.channelId}/messages/${request.anchorMessageId}/threads`,
				).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						name: threadName(request.title),
						auto_archive_duration: THREAD_ARCHIVE_MINUTES,
					}),
				),
			)
			const json = yield* response.json.pipe(
				Effect.mapError((cause) => failed("thread", "Discord's reply could not be read", { cause })),
			)
			const thread = yield* Schema.decodeUnknownEffect(CreatedThread)(json).pipe(
				Effect.mapError((cause) => failed("thread", "Discord answered with no thread id", { cause })),
			)
			return thread.id
		})

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

			openThread,

			/**
			 * What was said in this channel before a message, newest first.
			 *
			 * Discord answers newest-first already, which is the order the contract asks for and the
			 * order a bound should cut in. The page is read message by message, so one Maple cannot
			 * make sense of costs that message rather than the whole conversation around it.
			 */
			history: Effect.fn("Discord.history")(function* (
				target: ChatTarget,
				options: { readonly limit: number; readonly before: string },
			) {
				const limit = Math.min(options.limit, MAX_HISTORY_LIMIT)
				const response = yield* send(
					"history",
					"/channels/{channel_id}/messages",
					HttpClientRequest.get(
						`${API_BASE}/channels/${channelOf(target)}/messages?limit=${limit}&before=${encodeURIComponent(options.before)}`,
					),
				)
				const json = yield* response.json.pipe(
					Effect.mapError((cause) =>
						failed("history", "Discord's reply could not be read", { cause }),
					),
				)
				const page = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown))(json).pipe(
					// No `cause` on this one. What failed to decode is a page of other people's
					// messages, and a parse issue carries the values that did not fit — nothing reads
					// this failure but its operation, and a customer's conversation does not belong in
					// an error value one `Cause.pretty` away from a log line.
					Effect.mapError(() =>
						failed("history", "Discord did not answer with a list of messages"),
					),
				)
				return Arr.getSomes(Arr.map(page, historyMessage))
			}),

			/**
			 * A mention is answered in a thread of its own, so a channel keeps reading as a channel.
			 *
			 * The thread IS the conversation, and on Discord a thread is a channel — so its id is both
			 * the key and every later call's address, and a follow-up mention inside it arrives with
			 * that same id as its `channel_id` and lands on the same session.
			 *
			 * Discord will not start a thread from a message that is already in one, and answers the
			 * same way in a channel where the bot may not start them at all. Both mean the same thing
			 * here: the mention's own channel is the conversation.
			 *
			 * A CLICK opens nothing: the interaction already happened inside a conversation, and
			 * Discord's own `channel_id` for it is that conversation's id. Read from the interaction
			 * rather than from the control's payload, which is what lets the host refuse a control
			 * naming a conversation other than the one it was clicked in.
			 *
			 * A message that mentioned nobody opens nothing either, and costs no request. It can only
			 * ever continue a conversation that already exists — whether it does is the host's
			 * decision, made against the conversation this answers with.
			 */
			conversation: (event: InboundMessage | InboundAction) =>
				(event.type === "action" || !event.mentionsBot
					? Effect.succeed({ channelId: event.channelId, opened: false })
					: openThread({
							workspaceId: event.workspaceId,
							channelId: event.channelId,
							anchorMessageId: event.messageId,
							title: event.text,
						}).pipe(
							Effect.map((channelId) => ({ channelId, opened: true })),
							// Logged, because the refusal now decides more than where to post: a channel
							// the bot merely answers in is not one it will answer unaddressed messages
							// in, and a 429 or a 5xx lands in the same branch as the two expected
							// refusals without saying so.
							Effect.tapError((error) =>
								Effect.logWarning("No thread was opened for this mention").pipe(
									Effect.annotateLogs({
										"error.message": error.message,
										"http.response.status_code": error.status ?? 0,
									}),
								),
							),
							Effect.orElseSucceed(() => ({ channelId: event.channelId, opened: false })),
						)
				).pipe(
					Effect.flatMap(({ channelId, opened }) =>
						Option.match(decodeConversationKey(channelId), {
							onNone: () =>
								Effect.fail(
									failed("thread", "Discord named a conversation Maple cannot address"),
								),
							onSome: (conversationKey): Effect.Effect<ChatConversation> =>
								Effect.succeed({
									conversationKey,
									target: { workspaceId: event.workspaceId, channelId },
									opened,
								}),
						}),
					),
				),
		}
	}),
}

const failed = (
	operation: ChatOutboundOperation,
	message: string,
	extra: { readonly status?: number; readonly cause?: unknown } = {},
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
