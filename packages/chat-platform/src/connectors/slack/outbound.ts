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
 * that had one is deprecated and not available here. `conversations.list` takes its arguments as
 * a query string (it accepts no JSON body), pages with `response_metadata.next_cursor`, and allows
 * up to 1000 per page.
 */
import { ChatConversationKey } from "@maple/primitives"
import { Array as Arr, Duration, Effect, Option, Order, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import type { ConnectorConfig, InboundAction, InboundMessage } from "../../ingress"
import {
	ChatOutboundError,
	ConnectorCredentials,
	WORKSPACE_CREDENTIALS,
	type ChatConversation,
	type ChatDestination,
	type ChatOutboundFailureReason,
	type ChatHistoryMessage,
	type ChatMessageRef,
	type ChatOutbound,
	type ChatOutboundOperation,
	type ChatTarget,
	type ChatThreadRequest,
} from "../../outbound"
import type { ChatBlock } from "../../render/blocks"
import {
	API_HOST,
	CHANNEL_HISTORY_URL,
	CONVERSATIONS_LIST_URL,
	POST_MESSAGE_URL,
	THREAD_REPLIES_URL,
	UPDATE_MESSAGE_URL,
} from "./api"
import { decodeSlackCredentials } from "./credentials"
import { SLACK_CONNECTOR_ID } from "./id"
import { decodeApiResult, decodeChannel, decodeHistoryMessage, type SlackApiResult } from "./payloads"
import { renderSlackMessage, type SlackApiRequest, type SlackMessageRequest } from "./render"

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

/**
 * Slack's own ceiling is far higher (999 for a channel page, 1000 for a thread), and its
 * documentation recommends staying well under it. A conversation's context is bounded by what a
 * model can read anyway, so the request is bounded here rather than by the caller's optimism.
 */
const MAX_HISTORY_LIMIT = 200

/**
 * A `ts` is SECONDS with microsecond precision — `"1700000000.000100"`. Not `Number.parseFloat`:
 * that reads `"12abc"` as `12`, and a message dated from a value Slack did not send is worse than
 * one left out.
 */
const historySeconds = (ts: string): Option.Option<number> =>
	/^\d+\.\d+$/.test(ts) ? Option.some(Number(ts)) : Option.none()

/**
 * One earlier message, with the full-precision instant kept beside it.
 *
 * The contract carries epoch MILLISECONDS, and Slack's `ts` is finer than that — two messages sent
 * in the same second round to the same millisecond, and ordering them by the rounded value puts a
 * conversation in whatever order the page happened to arrive in. So the ordering uses the `ts` and
 * only the contract's field is rounded.
 *
 * Decoded per message rather than per page, deliberately: a page is CONTEXT, and one message this
 * connector cannot read — a subtype Slack added, a field that started arriving `null` — is not
 * worth losing the conversation around it for.
 *
 * `username` before `user` because a bot-posted message carries the first and not always the
 * second; the bare id is the last resort, and it is what an un-resolved author reads as throughout
 * this connector (see the README: a readable name needs a scope this app does not request).
 */
interface HistoryEntry {
	readonly seconds: number
	readonly message: ChatHistoryMessage
}

const historyEntry = (raw: unknown): Option.Option<HistoryEntry> =>
	Option.flatMap(decodeHistoryMessage(raw), (message) =>
		Option.map(historySeconds(message.ts), (seconds) => ({
			seconds,
			message: {
				displayName: message.username ?? message.user ?? "unknown",
				// Maple's own answers come back here too; the model is told which lines are its.
				isBot: message.bot_id !== undefined || message.subtype === "bot_message",
				text: message.text ?? "",
				at: Math.round(seconds * 1000),
			},
		})),
	)

/** One page of `conversations.list` at Slack's own maximum. */
const CHANNELS_PER_PAGE = 1000

/**
 * How many pages a listing walks before it stops. Five thousand channels is past any workspace a
 * person picks from by scrolling, and the method is Tier 2 — a longer walk is a rate limit.
 */
const MAX_CHANNEL_PAGES = 5

/**
 * The `ok: false` codes that say something a caller can act on, by what they mean.
 *
 * `missing_scope` is an AUTH failure on purpose: a workspace installed before a scope was added
 * holds a token without it, and only reinstalling the app grants it.
 */
const FAILURE_REASONS: ReadonlyMap<string, ChatOutboundFailureReason> = new Map([
	...[
		"invalid_auth",
		"not_authed",
		"account_inactive",
		"token_revoked",
		"token_expired",
		"missing_scope",
		"no_permission",
		"not_allowed_token_type",
		"team_access_not_granted",
		"ekm_access_denied",
	].map((code) => [code, "auth"] as const),
	...["channel_not_found", "not_in_channel", "is_archived"].map((code) => [code, "not_found"] as const),
	...[
		"invalid_blocks",
		"invalid_blocks_format",
		"msg_too_long",
		"no_text",
		"too_many_attachments",
		"invalid_arguments",
		"restricted_action",
	].map((code) => [code, "rejected"] as const),
])

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

/** A Web API call with a JSON body — every method this connector calls except the listing. */
const jsonRequest = (url: string, payload: SlackApiRequest) =>
	HttpClientRequest.post(url, {
		headers: { "content-type": "application/json; charset=utf-8" },
	}).pipe(HttpClientRequest.bodyJsonUnsafe(payload))

export const slackOutbound: ChatOutbound<HttpClient.HttpClient | ConnectorCredentials> = {
	connectorId: SLACK_CONNECTOR_ID,
	limits: { maxMessageChars: MAX_MESSAGE_CHARS, minEditInterval: MIN_EDIT_INTERVAL },
	// The bot token is per workspace and arrives under `WORKSPACE_CREDENTIALS`; nothing is
	// deployment-wide.
	requiredConfig: [],
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
			request: HttpClientRequest.HttpClientRequest,
		) {
			yield* Effect.annotateCurrentSpan({
				"peer.service": "slack",
				"http.request.method": request.method,
				"server.address": API_HOST,
				"url.template": `/api/${method}`,
			})
			const response = yield* client
				.execute(
					HttpClientRequest.setHeader(request, "authorization", `Bearer ${Redacted.value(bearer)}`),
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
				const reason = FAILURE_REASONS.get(error)
				return yield* failed(operation, `Slack refused the call: ${error}`, {
					status: response.status,
					...(reason === undefined ? undefined : { reason }),
				})
			}
			return result
		})

		const send = (
			operation: ChatOutboundOperation,
			method: string,
			request: HttpClientRequest.HttpClientRequest,
		): Effect.Effect<SlackApiResult, ChatOutboundError> => {
			// Checked BEFORE the client span is opened. The workspace having no stored token is a
			// Maple-side state — nobody linked it, or the envelope could not be opened — and
			// recording it inside a `Slack.request` span would put a failed edge on the service map
			// for a call that was never made.
			if (Option.isNone(token)) {
				return Effect.fail(failed(operation, "This Slack workspace is not connected to Maple"))
			}
			const bearer = token.value
			const tryOnce = (count: number): Effect.Effect<SlackApiResult, ChatOutboundError> =>
				attempt(bearer, operation, method, request).pipe(
					Effect.catchTag("@maple/chat-platform/connectors/slack/RateLimited", (limited) =>
						// A read of the conversation is CONTEXT, and the turn has not started yet —
						// waiting a rate limit out here delays the answer to buy background the model
						// can do without. An answer is worth waiting for; the history behind it is not.
						// A channel listing has somebody waiting on a picker, who is better told to
						// try again than left staring at a spinner for half a minute.
						count >= MAX_RATE_LIMIT_ATTEMPTS ||
						operation === "history" ||
						operation === "destinations"
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
					jsonRequest(POST_MESSAGE_URL, body(target.channelId, blocks, target.threadId)),
				)
				if (result.ts === undefined) {
					return yield* failed("post", "Slack answered with no message timestamp")
				}
				return { target, messageId: result.ts } satisfies ChatMessageRef
			}),

			edit: (ref: ChatMessageRef, blocks: ReadonlyArray<ChatBlock>) =>
				// `chat.update` addresses the message by its own `ts`; a thread is not named again.
				send(
					"edit",
					"chat.update",
					jsonRequest(UPDATE_MESSAGE_URL, {
						...body(ref.target.channelId, blocks),
						ts: ref.messageId,
					}),
				).pipe(Effect.asVoid),

			/**
			 * What was said in this conversation before a message, newest first.
			 *
			 * Two methods, one shape: a thread is `conversations.replies` addressed by its parent's
			 * `ts`, a channel is `conversations.history`, and both take the same bound. `latest` with
			 * `inclusive: false` is "everything before this message", which is what the contract asks
			 * for.
			 *
			 * The page is sorted here rather than trusted: `conversations.history` answers newest
			 * first and `conversations.replies` answers oldest first, and the contract wants one
			 * order. Sorting what came back costs nothing at these sizes and cannot be got wrong by a
			 * method Slack changes the default of.
			 *
			 * Sorting cannot recover what was never sent, though, and that is why a THREAD is asked
			 * for a full page rather than for `limit`: it answers from the OLDEST end, so a thread
			 * with more replies than the bound would otherwise hand back the start of the
			 * conversation and call it the newest. Asking for the ceiling and cutting here reads the
			 * right end of any thread up to that many replies — past which the oldest are dropped,
			 * which is the bound doing its job rather than the paging failing. A channel needs none
			 * of this: it answers from the newest end already.
			 */
			history: Effect.fn("Slack.history")(function* (
				target: ChatTarget,
				options: { readonly limit: number; readonly before: string },
			) {
				const limit = Math.min(options.limit, MAX_HISTORY_LIMIT)
				const thread = target.threadId
				const result = yield* send(
					"history",
					thread === undefined ? "conversations.history" : "conversations.replies",
					jsonRequest(thread === undefined ? CHANNEL_HISTORY_URL : THREAD_REPLIES_URL, {
						channel: target.channelId,
						limit: thread === undefined ? limit : MAX_HISTORY_LIMIT,
						latest: options.before,
						inclusive: false,
						...(thread === undefined ? undefined : { ts: thread }),
					}),
				)
				const page = Arr.getSomes(Arr.map(result.messages ?? [], historyEntry))
				return Arr.map(Arr.take(Arr.sort(page, newestFirst), limit), (entry) => entry.message)
			}),

			/**
			 * The workspace's unarchived public and private channels, by name.
			 *
			 * Private channels are listed only where the bot is a member — Slack's own rule for a bot
			 * token — which is exactly the set it can post to. Public channels are listed whether or
			 * not it has joined, because `chat:write.public` lets it post to them uninvited.
			 *
			 * The walk stops at {@link MAX_CHANNEL_PAGES}; a longer workspace lists a prefix.
			 */
			destinations: Effect.fn("Slack.destinations")(function* (_workspaceId: string) {
				const channels: Array<ChatDestination> = []
				let cursor: string | undefined
				let pages = 0
				for (; pages < MAX_CHANNEL_PAGES; pages++) {
					const params = new URLSearchParams({
						types: "public_channel,private_channel",
						exclude_archived: "true",
						limit: String(CHANNELS_PER_PAGE),
					})
					if (cursor !== undefined) params.set("cursor", cursor)
					const result = yield* send(
						"destinations",
						"conversations.list",
						HttpClientRequest.get(`${CONVERSATIONS_LIST_URL}?${params.toString()}`),
					)
					for (const channel of Arr.getSomes(
						Arr.map(result.channels ?? [], (raw) => decodeChannel(raw)),
					)) {
						channels.push({
							id: channel.id,
							name: channel.name ?? channel.id,
							private: channel.is_private === true,
						})
					}
					cursor = result.response_metadata?.next_cursor
					if (cursor === undefined || cursor === "") break
				}
				// A cursor still in hand after the last page is a workspace listed only in part.
				yield* Effect.annotateCurrentSpan({
					"chat.destinations.pages": Math.min(pages + 1, MAX_CHANNEL_PAGES),
					"chat.destinations.truncated": cursor !== undefined && cursor !== "",
				})
				return Arr.sort(channels, byName)
			}),

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
			 *
			 * A CLICK opens nothing: it happened inside a conversation that already exists, and the
			 * name this answers with is what scopes the approval. Ingress reads it from the thread
			 * the control's own message sits in, so it is the platform's address for where the click
			 * landed rather than anything reconstructed here.
			 */
			conversation: (message: InboundMessage | InboundAction) => {
				const threadId = message.threadId ?? message.messageId
				// A Slack thread begins with the reply that first carries the parent's `ts`, so a
				// top-level mention is a conversation THIS bot is about to open — and one the host
				// may then answer unaddressed messages in. A mention already inside a thread, and
				// every un-addressed follow-up, opens nothing. No request either way: the thread's
				// address is the anchor's own id.
				const opened =
					message.type === "message" && message.mentionsBot && threadId === message.messageId
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
							opened,
						}),
				})
			},
		}
	}),
}

/**
 * Newest first, the order the contract carries and the order a bound has to cut in.
 *
 * Over the `ts` rather than the contract's rounded `at`, so two messages in the same second still
 * order against each other.
 */
const newestFirst = Order.mapInput(Order.flip(Order.Number), (entry: HistoryEntry) => entry.seconds)

const byName = Order.mapInput(Order.String, (channel: ChatDestination) => channel.name)

const failed = (
	operation: ChatOutboundOperation,
	message: string,
	extra: {
		readonly status?: number
		readonly reason?: ChatOutboundFailureReason
		readonly cause?: unknown
	} = {},
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
