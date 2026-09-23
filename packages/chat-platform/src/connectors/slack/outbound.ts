/**
 * Slack's outbound half: the Web API over Effect's `HttpClient`.
 *
 * The bot token is per WORKSPACE, not per deployment — Slack mints one at install — so it arrives
 * inside the credentials the host sealed against this conversation's row and handed back under
 * `WORKSPACE_CREDENTIALS`. A conversation whose workspace nothing has linked therefore has no
 * token at all, and every call answers that rather than posting as somebody else.
 *
 * Every attempt is a `Client`-kind span carrying `peer.service` and the method's own path, the
 * same treatment alert delivery gives its providers, so the dependency is visible on the service
 * map. The path is a Web API METHOD name, which is already low-cardinality — Slack addresses a
 * channel in the body, not in the URL.
 *
 * Checked against Slack's Web API documentation: `chat.postMessage` takes `channel`, `text`,
 * `blocks` and `thread_ts`, `chat.update` takes `channel`, `ts`, `text` and `blocks`, most failures
 * arrive as HTTP 200 with `ok: false`, and a rate limit is a 429 with `Retry-After` in whole
 * seconds. There is no typing indicator for a bot token on the Web API at all — the RTM method
 * that had one is deprecated and not available here.
 */
import { ChatConversationKey } from "@maple/primitives"
import { Duration, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import type { ConnectorConfig, InboundMessage } from "../../ingress"
import {
	ChatOutboundError,
	ConnectorCredentials,
	WORKSPACE_CREDENTIALS,
	type ChatConversation,
	type ChatMessageRef,
	type ChatOutbound,
	type ChatOutboundOperation,
	type ChatTarget,
	type ChatThreadRequest,
} from "../../outbound"
import type { ChatBlock } from "../../render/blocks"
import { API_HOST, POST_MESSAGE_URL, UPDATE_MESSAGE_URL } from "./api"
import { decodeSlackCredentials } from "./credentials"
import { SLACK_CONNECTOR_ID } from "./id"
import { decodeApiResult } from "./payloads"
import { renderSlackMessage, type SlackMessageRequest } from "./render"

/**
 * The budget the neutral cutting is held to.
 *
 * Slack's own ceiling is 40000 characters of `text`, and a section block's is 3000 — but the real
 * limit is what somebody reads in a channel between other people's messages, so a turn is cut to
 * one section's worth and continues in the next message.
 */
const MAX_MESSAGE_CHARS = 3000

/**
 * Slack's `chat.*` tier is roughly one call per second per channel, bursts tolerated but not
 * promised. A streamed turn is edited at that rate rather than faster, so the budget goes on the
 * turn instead of on 429s.
 */
const MIN_EDIT_INTERVAL = Duration.seconds(1)

/** How many times a 429 is waited out before the turn gives up on the message. */
const MAX_RATE_LIMIT_ATTEMPTS = 3

/**
 * The longest a 429 may park a turn.
 *
 * `Retry-After` is a remote number reaching `Effect.sleep`: a workspace-wide limit can legitimately
 * ask for minutes, and a wrong value would pin the fiber for as long as it says. Waiting the
 * ceiling and trying again costs one attempt; obeying an unbounded value costs the turn.
 */
const MAX_RETRY_AFTER = Duration.seconds(30)

const DEFAULT_RETRY_AFTER = Duration.seconds(1)

/** Past an hour the value is not a rate limit, it is a bad number; fall through to the default. */
const MAX_RETRY_AFTER_SECONDS = 3600

/** Slack's two spellings for the same thing, both of which it documents. */
const RATE_LIMIT_ERRORS: ReadonlySet<string> = new Set(["ratelimited", "rate_limited"])

const decodeHeaderRetryAfter = Schema.decodeUnknownOption(
	Schema.FiniteFromString.pipe(
		Schema.check(Schema.isBetween({ minimum: 0, maximum: MAX_RETRY_AFTER_SECONDS })),
	),
)

/**
 * A channel and the thread inside it, joined into one key.
 *
 * Slack models a thread as a coordinate within a channel rather than as a channel of its own, so
 * it takes both to name a conversation. A `ts` is `1700000000.000100` — digits and a dot, which
 * the key's charset carries, and the `:` between them is in it too.
 */
const conversationKeyOf = (channelId: string, threadId: string): string => `${channelId}:${threadId}`

/**
 * Every id Slack mints fits the key's charset — but these came off the wire, so they are decoded
 * rather than branded, and one that is not fails the turn instead of escaping as a defect.
 */
const decodeConversationKey = Schema.decodeUnknownOption(ChatConversationKey)

/** Internal to the retry loop: a rate limit and how long it asked for. Never leaves this module. */
class SlackRateLimited extends Schema.TaggedError<SlackRateLimited>()(
	"@maple/chat-platform/connectors/slack/RateLimited",
	{ wait: Schema.Duration },
) {}

export const slackOutbound: ChatOutbound<HttpClient.HttpClient | ConnectorCredentials> = {
	connectorId: SLACK_CONNECTOR_ID,
	limits: { maxMessageChars: MAX_MESSAGE_CHARS, minEditInterval: MIN_EDIT_INTERVAL },
	transport: Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const config: ConnectorConfig = yield* ConnectorCredentials
		const credentials = decodeSlackCredentials(config.get(WORKSPACE_CREDENTIALS))
		const token = Option.map(credentials, (value) => Redacted.make(value.bot_token))

		/**
		 * One Web API call, as one client span.
		 *
		 * A rate limit fails with {@link SlackRateLimited} rather than being retried in here, so the
		 * attempts it costs are sibling spans that each record their own status instead of nesting
		 * three deep under the first one.
		 */
		const attempt = Effect.fn("Slack.request", { kind: "client" })(function* (
			bearer: Redacted.Redacted<string>,
			operation: ChatOutboundOperation,
			method: string,
			url: string,
			payload: SlackMessageRequest,
		) {
			yield* Effect.annotateCurrentSpan({
				"peer.service": "slack",
				"http.request.method": "POST",
				"server.address": API_HOST,
				"url.template": `/api/${method}`,
			})
			const response = yield* client
				.execute(
					HttpClientRequest.post(url, {
						headers: {
							authorization: `Bearer ${Redacted.value(bearer)}`,
							"content-type": "application/json; charset=utf-8",
						},
					}).pipe(HttpClientRequest.bodyJsonUnsafe(payload)),
				)
				.pipe(
					// The reason matters: an encode or invalid-url failure is Maple's own bug, and
					// collapsing it into "Slack was unreachable" files it forever as Slack's.
					Effect.mapError((cause) =>
						failed(operation, `Slack request failed (${cause.reason._tag})`, { cause }),
					),
				)
			yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
			if (response.status === 429) return yield* new SlackRateLimited({ wait: retryAfter(response) })
			if (response.status >= 300) {
				return yield* failed(operation, `Slack answered ${response.status}`, {
					status: response.status,
				})
			}
			const json = yield* response.json.pipe(
				Effect.mapError((cause) => failed(operation, "Slack's reply could not be read", { cause })),
			)
			const result = yield* decodeApiResult(json).pipe(
				Effect.mapError((cause) =>
					failed(operation, "Slack answered something unreadable", { cause }),
				),
			)
			// Slack reports most failures with a 200, so the status told us nothing on its own.
			if (!result.ok) {
				const error = result.error ?? "unknown"
				yield* Effect.annotateCurrentSpan({ "error.type": error })
				if (RATE_LIMIT_ERRORS.has(error)) {
					return yield* new SlackRateLimited({ wait: retryAfter(response) })
				}
				return yield* failed(operation, `Slack refused the call: ${error}`, {
					status: response.status,
				})
			}
			return result
		})

		const send = (
			operation: ChatOutboundOperation,
			method: string,
			url: string,
			payload: SlackMessageRequest,
		): Effect.Effect<{ readonly ts?: string | undefined }, ChatOutboundError> => {
			// Checked BEFORE the client span is opened. The workspace having no stored token is a
			// Maple-side state — nobody linked it, or the envelope could not be opened — and
			// recording it inside a `Slack.request` span would put a failed edge on the service map
			// for a call that was never made.
			if (Option.isNone(token)) {
				return Effect.fail(failed(operation, "This Slack workspace is not connected to Maple"))
			}
			const bearer = token.value
			const tryOnce = (
				count: number,
			): Effect.Effect<{ readonly ts?: string | undefined }, ChatOutboundError> =>
				attempt(bearer, operation, method, url, payload).pipe(
					Effect.catchTag("@maple/chat-platform/connectors/slack/RateLimited", (limited) =>
						count >= MAX_RATE_LIMIT_ATTEMPTS
							? Effect.fail(
									failed(operation, "Slack kept rate limiting this message", {
										status: 429,
									}),
								)
							: Effect.sleep(limited.wait).pipe(Effect.andThen(tryOnce(count + 1))),
					),
				)
			return tryOnce(1)
		}

		/** `thread_ts` is left out entirely when there is no thread; Slack rejects an empty one. */
		const body = (
			channelId: string,
			blocks: ReadonlyArray<ChatBlock>,
			threadId?: string,
		): SlackMessageRequest => ({
			channel: channelId,
			...renderSlackMessage(blocks),
			...(threadId === undefined ? undefined : { thread_ts: threadId }),
		})

		return {
			post: Effect.fn("Slack.post")(function* (target: ChatTarget, blocks: ReadonlyArray<ChatBlock>) {
				const result = yield* send(
					"post",
					"chat.postMessage",
					POST_MESSAGE_URL,
					body(target.channelId, blocks, target.threadId),
				)
				if (result.ts === undefined) {
					return yield* failed("post", "Slack answered with no message timestamp")
				}
				return { target, messageId: result.ts } satisfies ChatMessageRef
			}),

			edit: (ref: ChatMessageRef, blocks: ReadonlyArray<ChatBlock>) =>
				// `chat.update` addresses the message by its own `ts`; a thread is not named again.
				send("edit", "chat.update", UPDATE_MESSAGE_URL, {
					...body(ref.target.channelId, blocks),
					ts: ref.messageId,
				}).pipe(Effect.asVoid),

			/**
			 * Slack has no typing indicator a bot token can set. Rather than spend a call on
			 * something that shows nothing, the driver's first posted message is the acknowledgement.
			 */
			typing: () => Effect.void,

			/**
			 * A Slack thread is not an object — it is every message that carries the anchor's `ts` as
			 * its `thread_ts` — so opening one is nothing to do and the anchor's own id is its
			 * address.
			 */
			openThread: (request: ChatThreadRequest) => Effect.succeed(request.anchorMessageId),

			/**
			 * A mention is answered in its own thread, so a channel keeps reading as a channel.
			 *
			 * A top-level mention's `ts` becomes the thread, and a mention already inside one keeps
			 * that thread — which is what `ingress` put in `threadId`, so this performs no I/O. A
			 * follow-up in the same thread arrives with the same `thread_ts` and lands on the same
			 * session without anything being remembered between events.
			 */
			conversation: (message: InboundMessage) => {
				const threadId = message.threadId ?? message.messageId
				return Option.match(decodeConversationKey(conversationKeyOf(message.channelId, threadId)), {
					onNone: () =>
						Effect.fail(failed("thread", "Slack named a conversation Maple cannot address")),
					onSome: (conversationKey): Effect.Effect<ChatConversation> =>
						Effect.succeed({
							conversationKey,
							target: {
								workspaceId: message.workspaceId,
								channelId: message.channelId,
								threadId,
							},
						}),
				})
			},
		}
	}),
}

const failed = (
	operation: ChatOutboundOperation,
	message: string,
	extra: { readonly status?: number; readonly cause?: unknown } = {},
) => new ChatOutboundError({ message, connectorId: SLACK_CONNECTOR_ID, operation, ...extra })

/**
 * How long Slack asked us to wait, clamped.
 *
 * `Retry-After` is the documented source and the only one: unlike some APIs, Slack's rate-limit
 * body carries no duration of its own, so a 200-with-`ratelimited` falls back to the default.
 */
const retryAfter = (response: HttpClientResponse.HttpClientResponse): Duration.Duration => {
	const seconds = decodeHeaderRetryAfter(response.headers["retry-after"])
	return Duration.min(
		MAX_RETRY_AFTER,
		Option.isSome(seconds) ? Duration.seconds(seconds.value) : DEFAULT_RETRY_AFTER,
	)
}
