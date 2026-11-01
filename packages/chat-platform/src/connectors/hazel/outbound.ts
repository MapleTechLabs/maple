/**
 * Hazel's outbound half: its public bot API (`/api/v1`) over Effect's `HttpClient`, authenticated
 * by the bot token the host resolves (`ConnectorCredentials`) — this package never reads an
 * environment.
 *
 * Every attempt is a `Client`-kind span carrying `peer.service` and the route TEMPLATE, never the
 * concrete path: a channel and a message id are high-cardinality and one of them names the
 * conversation.
 *
 * The API (`@hazel/domain/http` `api-v1-messages`, `api-v1-bots`): create is `POST /messages`, edit
 * is `PATCH /messages/{id}` naming its channel, history is `GET /messages?channel_id=` newest first
 * with Stripe-style cursors, a thread is `POST /channels/{id}/threads` (idempotent: a message's
 * thread is answered again), the people behind ids are `GET /organizations/{id}/users?ids=`, and
 * the channels the bot can post in are `GET /organizations/{id}/bot-channels`.
 * A thread IS a channel, so once a turn answers in one every call addresses the thread's id.
 *
 * A turn streams through the message's live state (`POST /messages/{id}/live`, `@hazel/domain/live`)
 * rather than through edits: the message is created with a `liveState` embed, its text goes out as
 * `AppendText` (or `SetText`, when a render takes words back), and the final write closes the live
 * state with `Complete` or `Fail` and writes the finished message — its content, for search,
 * notifications and history, and the same state as the embed's snapshot, for a client without the
 * live socket.
 */
import { ChatConversationKey } from "@maple/primitives"
import { Array as Arr, Clock, Duration, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import type { ConnectorConfig, InboundAction, InboundMessage } from "../../ingress"
import {
	ChatOutboundError,
	ConnectorCredentials,
	type ChatConversation,
	type ChatHistoryMessage,
	type ChatMessageRef,
	type ChatOutbound,
	type ChatOutboundFailureReason,
	type ChatOutboundOperation,
	type ChatTarget,
	type ChatThreadRequest,
	type ChatWritePhase,
} from "../../outbound"
import type { ChatBlock } from "../../render/blocks"
import { API_BASE, API_HOST, BOT_TOKEN_CONFIG } from "./api"
import { mentionOf } from "./gateway-events"
import { HAZEL_CONNECTOR_ID } from "./id"
import {
	MAX_CONTENT_CHARS,
	renderHazelLive,
	renderHazelMessage,
	type HazelEmbed,
	type HazelLiveBody,
	type HazelMessageBody,
} from "./render"

const botToken = (config: ConnectorConfig): Redacted.Redacted<string> =>
	Redacted.make(config.get(BOT_TOKEN_CONFIG) ?? "")

/** Under the renderer's own clamp, so a connector's decoration has somewhere to go. */
const MAX_MESSAGE_CHARS = MAX_CONTENT_CHARS - 400

/**
 * Hazel allows a bot 120 message writes a minute, edits included, shared by every conversation it
 * is answering in. A streamed turn spends almost none of it: its text goes to the message's live
 * state, which that limit does not count, and the message itself is written when it is created,
 * when its embeds change, and once at the end. So the driver writes as often as a reader can tell.
 */
const MIN_EDIT_INTERVAL = Duration.millis(250)

/** How many times a 429 is waited out before the turn gives up on the message. */
const MAX_RATE_LIMIT_ATTEMPTS = 3

/** The longest a 429 may park a turn: a remote number reaching `Effect.sleep` is bounded here. */
const MAX_RETRY_AFTER = Duration.seconds(10)

const DEFAULT_RETRY_AFTER = Duration.seconds(1)

/** Hazel's own ceiling on one page of history. */
const MAX_HISTORY_LIMIT = 100

/** Hazel's 429 body (`RateLimitExceededError`). */
const RateLimited = Schema.Struct({
	retryAfterMs: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 3_600_000 })),
})

/** The live-state actions this connector sends (`@hazel/domain/live` `LiveAction`). */
type LiveAction =
	| { readonly _tag: "Start" }
	| { readonly _tag: "AppendText"; readonly text: string }
	| { readonly _tag: "SetText"; readonly text: string }
	| { readonly _tag: "Complete"; readonly persist: false }
	| { readonly _tag: "Fail"; readonly error: string; readonly persist: false }

/** What a live message holds as far as this transport last wrote it. */
interface Streamed {
	/** Unknown while a write is in flight, or for a message an earlier run streamed. */
	readonly text: string | undefined
	/** A fingerprint of its embeds: a change is the one message write a turn makes before its end. */
	readonly embeds: string | undefined
	/** Whether its live state was started. Until it is, Hazel shows the loading indicator over any text. */
	readonly started: boolean
}

/** The cheapest action that takes the live text from `previous` to `next`, or none at all. */
const textUpdate = (previous: string | undefined, next: string): LiveAction | null => {
	if (previous === next) return null
	if (previous !== undefined && next.startsWith(previous))
		return { _tag: "AppendText", text: next.slice(previous.length) }
	return { _tag: "SetText", text: next }
}

/** Only ever compared with the previous write's; nothing decodes it. */
const fingerprint = (embeds: ReadonlyArray<HazelEmbed>): string => JSON.stringify(embeds)

/** A live message's embeds while it streams: the live state first, then its cards. */
const streamingEmbeds = (body: HazelLiveBody): ReadonlyArray<HazelEmbed> => [
	{ liveState: { enabled: true, ...(body.loading === null ? undefined : { loading: body.loading }) } },
	...body.embeds,
]

/** A finished live message's embeds: the state it ended in, for a client without the live socket. */
const finishedEmbeds = (body: HazelLiveBody): ReadonlyArray<HazelEmbed> => [
	{
		liveState: {
			enabled: true,
			cached: {
				status: body.error === null ? "completed" : "failed",
				data: {},
				...(body.text === "" ? undefined : { text: body.text }),
				...(body.error === null ? undefined : { error: body.error }),
			},
		},
	},
	...body.embeds,
]

const MessageCreated = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })

const ThreadCreated = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })

/** One earlier message, as far as the model's context reads it. */
const HistoryMessage = Schema.Struct({
	authorId: Schema.String,
	content: Schema.String,
	/** ISO-8601. A value that will not parse leaves the message out rather than dating it to 1970. */
	createdAt: Schema.String,
})
const decodeHistoryMessage = Schema.decodeUnknownOption(HistoryMessage)

const HistoryPage = Schema.Struct({ data: Schema.Array(Schema.Unknown) })

const Users = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({ id: Schema.String, displayName: Schema.String, isBot: Schema.Boolean }),
	),
})

/** The public channels, and the private ones the bot was added to, already sorted by name. */
const Channels = Schema.Struct({
	data: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, private: Schema.Boolean })),
})

/** Who an id is, as far as the model's context names them. */
interface Person {
	readonly displayName: string
	readonly isBot: boolean
}

/** The ids a message mentions, so the context can name them rather than show markup. */
const MENTION = /@\[userId:([0-9a-f-]{36})\]/gu

const mentionedIds = (text: string): ReadonlyArray<string> =>
	Array.from(text.matchAll(MENTION)).flatMap((match) => (match[1] === undefined ? [] : [match[1]]))

/**
 * A conversation's key: the channel (or thread) id without its dashes, which the key's charset
 * refuses. Hazel ids are UUIDs, so nothing is lost.
 */
const decodeConversationKey = (channelId: string) =>
	Schema.decodeUnknownOption(ChatConversationKey)(channelId.replaceAll("-", ""))

/** The thread when the turn is in one, the channel otherwise — on Hazel both are channel ids. */
const channelOf = (target: ChatTarget): string => target.threadId ?? target.channelId

const reasonForStatus = (status: number): ChatOutboundFailureReason | undefined => {
	if (status === 401 || status === 403) return "auth"
	if (status === 404) return "not_found"
	if (status === 400) return "rejected"
	return undefined
}

/** Internal to the retry loop: a 429 and how long it asked for. */
class HazelRateLimited extends Schema.TaggedError<HazelRateLimited>()(
	"@maple/chat-platform/connectors/hazel/RateLimited",
	{ wait: Schema.Duration },
) {}

export const hazelOutbound: ChatOutbound<HttpClient.HttpClient | ConnectorCredentials> = {
	connectorId: HAZEL_CONNECTOR_ID,
	limits: { maxMessageChars: MAX_MESSAGE_CHARS, minEditInterval: MIN_EDIT_INTERVAL },
	liveMessages: true,
	requiredConfig: [{ name: BOT_TOKEN_CONFIG, secret: true }],
	transport: Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		// Per call, not here: acquiring the transport must not cost the host its credential read.
		const token = Effect.map(yield* ConnectorCredentials, botToken)

		const attempt = Effect.fn("Hazel.request", { kind: "client" })(function* (
			bearer: Redacted.Redacted<string>,
			operation: ChatOutboundOperation,
			route: string,
			request: HttpClientRequest.HttpClientRequest,
		) {
			yield* Effect.annotateCurrentSpan({
				"peer.service": "hazel",
				"http.request.method": request.method,
				"server.address": API_HOST,
				"url.template": route,
			})
			const response = yield* client
				.execute(
					HttpClientRequest.setHeader(request, "authorization", `Bearer ${Redacted.value(bearer)}`),
				)
				.pipe(
					Effect.mapError((cause) =>
						failed(operation, `Hazel request failed (${cause.reason._tag})`, { cause }),
					),
				)
			yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
			if (response.status === 429)
				return yield* new HazelRateLimited({ wait: yield* retryAfter(response) })
			if (response.status >= 300) {
				const reason = reasonForStatus(response.status)
				return yield* failed(operation, `Hazel answered ${response.status}`, {
					status: response.status,
					...(reason === undefined ? undefined : { reason }),
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
						Effect.catchTag("@maple/chat-platform/connectors/hazel/RateLimited", (limited) =>
							// History is CONTEXT read before the turn starts: waiting out a rate limit
							// there delays the answer for background the model can do without.
							count >= MAX_RATE_LIMIT_ATTEMPTS || operation === "history"
								? Effect.fail(
										failed(operation, "Hazel kept rate limiting this message", {
											status: 429,
										}),
									)
								: Effect.andThen(Effect.sleep(limited.wait), tryOnce(count + 1)),
						),
					)
				return tryOnce(1)
			})

		/** The reply's JSON in `schema`, failing the operation (without the body) when it is not. */
		const read = <A>(
			operation: ChatOutboundOperation,
			response: HttpClientResponse.HttpClientResponse,
			schema: Schema.Codec<A, unknown>,
			what: string,
		) =>
			response.json.pipe(
				Effect.mapError((cause) => failed(operation, "Hazel's reply could not be read", { cause })),
				Effect.flatMap((json) =>
					Schema.decodeUnknownEffect(schema)(json).pipe(
						Effect.mapError(() => failed(operation, `Hazel answered with ${what}`)),
					),
				),
			)

		const postBody = (channelId: string, body: HazelMessageBody) =>
			HttpClientRequest.bodyJsonUnsafe({
				channelId,
				content: body.content,
				embeds: body.embeds.length === 0 ? null : body.embeds,
				replyToMessageId: null,
				threadChannelId: null,
			})

		const post = Effect.fn("Hazel.post")(function* (
			target: ChatTarget,
			blocks: ReadonlyArray<ChatBlock>,
		) {
			const response = yield* send(
				"post",
				"/messages",
				HttpClientRequest.post(`${API_BASE}/messages`).pipe(
					postBody(channelOf(target), renderHazelMessage(blocks)),
				),
			)
			const created = yield* read("post", response, MessageCreated, "no message id")
			return { target, messageId: created.data.id }
		})

		const patch = (ref: ChatMessageRef, body: HazelMessageBody) =>
			send(
				"edit",
				"/messages/{message_id}",
				HttpClientRequest.patch(`${API_BASE}/messages/${encodeURIComponent(ref.messageId)}`).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						channelId: channelOf(ref.target),
						content: body.content,
						embeds: body.embeds.length === 0 ? null : body.embeds,
					}),
				),
			).pipe(Effect.asVoid)

		/** Not a message write: Hazel does not count these against the bot's 120 a minute. */
		const writeLive = (ref: ChatMessageRef, action: LiveAction) =>
			send(
				"edit",
				"/messages/{message_id}/live",
				HttpClientRequest.post(`${API_BASE}/messages/${encodeURIComponent(ref.messageId)}/live`).pipe(
					HttpClientRequest.bodyJsonUnsafe({ channelId: channelOf(ref.target), action }),
				),
			).pipe(Effect.asVoid)

		// The live messages this turn is writing. The driver acquires a transport per turn, and only
		// a turn's driver writes with a phase, so this lives as long as the turn and no longer.
		const streamed = new Map<string, Streamed>()

		/** Bring a live message up to `body`: its embeds if they changed, then its text. */
		const stream = Effect.fn("Hazel.stream")(function* (ref: ChatMessageRef, body: HazelLiveBody) {
			let state = streamed.get(ref.messageId) ?? { text: undefined, embeds: undefined, started: true }
			const embeds = fingerprint(body.embeds)
			if (state.embeds !== embeds) {
				yield* patch(ref, { content: body.content, embeds: streamingEmbeds(body) })
				state = { ...state, embeds }
				streamed.set(ref.messageId, state)
			}
			if (!state.started) {
				yield* writeLive(ref, { _tag: "Start" })
				state = { ...state, started: true }
				streamed.set(ref.messageId, state)
			}
			const update = textUpdate(state.text, body.text)
			if (update === null) return
			// Unknown until Hazel answers: an append that landed but whose answer was lost must not be
			// appended again, so the next write replaces the text instead.
			streamed.set(ref.messageId, { ...state, text: undefined })
			yield* writeLive(ref, update)
			streamed.set(ref.messageId, { ...state, text: body.text })
		})

		const postLive = Effect.fn("Hazel.postLive")(function* (
			target: ChatTarget,
			blocks: ReadonlyArray<ChatBlock>,
		) {
			const body = renderHazelLive(blocks)
			const response = yield* send(
				"post",
				"/messages",
				HttpClientRequest.post(`${API_BASE}/messages`).pipe(
					postBody(channelOf(target), { content: body.content, embeds: streamingEmbeds(body) }),
				),
			)
			const created = yield* read("post", response, MessageCreated, "no message id")
			const ref = { target, messageId: created.data.id }
			streamed.set(ref.messageId, { text: "", embeds: fingerprint(body.embeds), started: false })
			// The message exists, so the post succeeded: a live state that would not start is retried
			// by the next write, and the final one writes the whole answer into the message anyway.
			yield* stream(ref, body).pipe(
				Effect.tapError(report("A live message could not be started")),
				Effect.ignore,
			)
			return ref
		})

		const finishLive = Effect.fn("Hazel.finishLive")(function* (
			ref: ChatMessageRef,
			blocks: ReadonlyArray<ChatBlock>,
		) {
			const body = renderHazelLive(blocks)
			const state = streamed.get(ref.messageId)
			streamed.delete(ref.messageId)
			// Best effort: the message write below carries the same finished state to every client, and
			// a reader with the live socket open only misses the moment it completed.
			yield* Effect.gen(function* () {
				const update = textUpdate(state?.text, body.text)
				if (update !== null) yield* writeLive(ref, update)
				// `persist: false`: the write below is the snapshot. Hazel's own would replace the
				// message's embeds with it, and an approval's buttons with them.
				yield* writeLive(
					ref,
					body.error === null
						? { _tag: "Complete", persist: false }
						: { _tag: "Fail", error: body.error, persist: false },
				)
			}).pipe(Effect.tapError(report("A live message could not be closed")), Effect.ignore)
			yield* patch(ref, { content: body.content, embeds: finishedEmbeds(body) })
		})

		const openThread = Effect.fn("Hazel.openThread")(function* (request: ChatThreadRequest) {
			const response = yield* send(
				"thread",
				"/channels/{channel_id}/threads",
				HttpClientRequest.post(
					`${API_BASE}/channels/${encodeURIComponent(request.channelId)}/threads`,
				).pipe(HttpClientRequest.bodyJsonUnsafe({ messageId: request.anchorMessageId })),
			)
			const thread = yield* read("thread", response, ThreadCreated, "no thread id")
			return thread.data.id
		})

		/** The people behind `ids` in the workspace; an id Hazel does not know is simply absent. */
		const people = (
			workspaceId: string,
			ids: ReadonlyArray<string>,
		): Effect.Effect<ReadonlyMap<string, Person>, ChatOutboundError> =>
			ids.length === 0
				? Effect.succeed(new Map<string, Person>())
				: send(
						"history",
						"/organizations/{organization_id}/users",
						HttpClientRequest.get(
							`${API_BASE}/organizations/${encodeURIComponent(workspaceId)}/users?ids=${encodeURIComponent(ids.join(","))}`,
						),
					).pipe(
						Effect.flatMap((response) => read("history", response, Users, "no list of people")),
						Effect.map((users) => new Map(users.data.map((user) => [user.id, user]))),
					)

		return {
			/** A turn's message streams; anything else — a notice, a tail posted at the end — is plain. */
			post: (target: ChatTarget, blocks: ReadonlyArray<ChatBlock>, phase?: ChatWritePhase) =>
				phase === "streaming" ? postLive(target, blocks) : post(target, blocks),

			/**
			 * A write without a phase — a settled approval — is a plain edit, and leaves the message
			 * plain: its content then says everything, buttons gone.
			 */
			edit: (ref: ChatMessageRef, blocks: ReadonlyArray<ChatBlock>, phase?: ChatWritePhase) => {
				if (phase === "streaming") return stream(ref, renderHazelLive(blocks))
				if (phase === "final") return finishLive(ref, blocks)
				return patch(ref, renderHazelMessage(blocks))
			},

			/**
			 * Hazel cannot show a message to one person, so a whisper is a message in the conversation
			 * that mentions them: they are notified, and anyone else reading sees what it was about.
			 */
			whisper: Effect.fn("Hazel.whisper")(function* (
				action: InboundAction,
				blocks: ReadonlyArray<ChatBlock>,
			) {
				const body = renderHazelMessage(blocks)
				yield* send(
					"whisper",
					"/messages",
					HttpClientRequest.post(`${API_BASE}/messages`).pipe(
						postBody(action.channelId, {
							...body,
							content: `${mentionOf(action.actor.id)} ${body.content}`,
						}),
					),
				)
			}),

			/**
			 * A no-op: Hazel's typing indicator is a channel member's, and the bot is not one in a
			 * public channel. The placeholder the driver posts first already says it is working.
			 */
			typing: () => Effect.void,

			openThread,

			/**
			 * What was said in this conversation before a message, newest first — Hazel's own order —
			 * with each author's name read once for the page, and mentions shown as names.
			 */
			history: Effect.fn("Hazel.history")(function* (
				target: ChatTarget,
				options: { readonly limit: number; readonly before: string },
			) {
				const limit = Math.min(options.limit, MAX_HISTORY_LIMIT)
				const response = yield* send(
					"history",
					"/messages",
					HttpClientRequest.get(
						`${API_BASE}/messages?channel_id=${encodeURIComponent(channelOf(target))}&starting_after=${encodeURIComponent(options.before)}&limit=${limit}`,
					),
				)
				const page = yield* read("history", response, HistoryPage, "no list of messages")
				const messages = Arr.getSomes(page.data.map((raw) => decodeHistoryMessage(raw)))
				const ids = [
					...new Set(
						messages.flatMap((message) => [message.authorId, ...mentionedIds(message.content)]),
					),
				]
				// Names are best effort: a page with "Someone" in it beats no context at all.
				const names = yield* people(target.workspaceId, ids).pipe(
					Effect.orElseSucceed((): ReadonlyMap<string, Person> => new Map()),
				)
				return Arr.getSomes(
					messages.map((message): Option.Option<ChatHistoryMessage> => {
						const at = Date.parse(message.createdAt)
						if (Number.isNaN(at)) return Option.none()
						const author = names.get(message.authorId)
						return Option.some({
							displayName: author?.displayName ?? "Someone",
							isBot: author?.isBot ?? false,
							text: message.content.replace(
								MENTION,
								(_, id: string) => `@${names.get(id)?.displayName ?? "someone"}`,
							),
							at,
						})
					}),
				)
			}),

			/**
			 * What Hazel says the bot may post in: every public channel of the workspace and the
			 * private ones it was added to. Threads and direct messages are never listed.
			 */
			destinations: Effect.fn("Hazel.destinations")(function* (workspaceId: string) {
				const response = yield* send(
					"destinations",
					"/organizations/{organization_id}/bot-channels",
					HttpClientRequest.get(
						`${API_BASE}/organizations/${encodeURIComponent(workspaceId)}/bot-channels`,
					),
				)
				const page = yield* read("destinations", response, Channels, "no list of channels")
				return page.data
			}),

			/**
			 * A mention is answered in a thread on it, so a channel keeps reading as a channel. On
			 * Hazel a thread is a channel, so its id is the key and every later call's address, and a
			 * follow-up mention inside it arrives with that id and lands on the same session. A
			 * mention that is already in a thread answers with that thread (Hazel replies in it), and
			 * is a conversation the bot was brought into — so both are the bot's own.
			 *
			 * A press opens nothing: it happened inside a conversation, and Hazel's own channel id for
			 * it names that conversation. Read from the event rather than the button, which is what
			 * lets the host refuse a control naming another conversation. An unaddressed message
			 * opens nothing either and costs no request.
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
									failed("thread", "Hazel named a conversation Maple cannot address"),
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

/** What failed, never the request it failed on: its body is the conversation. */
const report = (message: string) => (error: ChatOutboundError) =>
	Effect.logWarning(message).pipe(
		Effect.annotateLogs({
			"error.message": error.message,
			"http.response.status_code": error.status ?? 0,
		}),
	)

const failed = (
	operation: ChatOutboundOperation,
	message: string,
	extra: {
		readonly status?: number
		readonly reason?: ChatOutboundFailureReason
		readonly cause?: unknown
	} = {},
) => new ChatOutboundError({ message, connectorId: HAZEL_CONNECTOR_ID, operation, ...extra })

/** How long Hazel asked us to wait, clamped: its body's `retryAfterMs`, else the `retry-after` header. */
const retryAfter = (response: HttpClientResponse.HttpClientResponse) =>
	response.json.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(RateLimited)),
		Effect.map((limited) => Duration.millis(limited.retryAfterMs)),
		Effect.catch(() =>
			Effect.map(Clock.currentTimeMillis, (now) =>
				headerRetryAfter(response.headers["retry-after"], now),
			),
		),
		Effect.map(Duration.min(MAX_RETRY_AFTER)),
	)

/**
 * A `retry-after` header: delay-seconds or an HTTP-date. Absent, blank, unparseable or already past
 * is the default rather than zero, which would retry at once into the same limit.
 */
export const headerRetryAfter = (value: string | undefined, now: number): Duration.Duration => {
	const trimmed = value?.trim() ?? ""
	if (trimmed === "") return DEFAULT_RETRY_AFTER
	if (/^\d+$/u.test(trimmed)) return Duration.seconds(Number(trimmed))
	const at = Date.parse(trimmed)
	return Number.isNaN(at) || at <= now ? DEFAULT_RETRY_AFTER : Duration.millis(at - now)
}
