/**
 * The transport against a stubbed HTTP client — what a real Discord cannot be asked to reproduce
 * on demand: a 429, and a rejection that has to reach the driver as a typed failure.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import type { InboundAction, InboundMessage } from "../../ingress"
import { ChatOutboundError, ConnectorCredentials } from "../../outbound"
import { BOT_TOKEN_CONFIG } from "./api"
import { DISCORD_CONNECTOR_ID } from "./id"
import { discordOutbound } from "./outbound"

interface Attempt {
	readonly status: number
	readonly body: string
	readonly headers?: Record<string, string>
}

const stub = (attempts: ReadonlyArray<Attempt>) => {
	const seen: Array<HttpClientRequest.HttpClientRequest> = []
	const client = HttpClient.make((request) => {
		const attempt = attempts[Math.min(seen.length, attempts.length - 1)]
		seen.push(request)
		return Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				new Response(attempt.body, { status: attempt.status, headers: attempt.headers }),
			),
		)
	})
	return {
		seen,
		layer: Layer.mergeAll(
			Layer.succeed(HttpClient.HttpClient)(client),
			Layer.succeed(ConnectorCredentials)(Effect.succeed(new Map([[BOT_TOKEN_CONFIG, "bot-token"]]))),
		),
	}
}

const target = { workspaceId: "guild_1", channelId: "conv_1" }

interface ThreadBody {
	readonly name: string
	readonly auto_archive_duration: number
}

/** The thread body a request carried, for the fields Discord's limits apply to. */
const sentThreadBody = (request: HttpClientRequest.HttpClientRequest): ThreadBody => {
	const body = request.body
	if (body._tag !== "Uint8Array") throw new Error("the request carried no JSON body")
	// SAFETY: the body under test is the one `openThread` just wrote, two lines of this file's
	// subject; a wrong one fails the assertion it feeds rather than escaping as a bad type.
	return JSON.parse(new TextDecoder().decode(body.body)) as ThreadBody
}

const CREATED = '{"id":"m1","channel_id":"conv_1"}'

const mention: InboundMessage = {
	type: "message",
	connector: DISCORD_CONNECTOR_ID,
	workspaceId: "guild_1",
	channelId: "conv_1",
	messageId: "msg_3",
	author: { id: "user_2", displayName: "Ada", isBot: false },
	text: "why is checkout slow",
	mentionsBot: true,
}

describe("discord transport", () => {
	it.effect("authorizes as a bot and answers with the message it created", () => {
		const http = stub([{ status: 200, body: CREATED }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const ref = yield* transport.post(target, [{ kind: "prose", markdown: "hello" }])

			expect(ref).toEqual({ target, messageId: "m1" })
			expect(http.seen[0].headers["authorization"]).toBe("Bot bot-token")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("answers a click privately, on the interaction's own follow-up webhook", () => {
		const http = stub([{ status: 200, body: CREATED }])
		const click: InboundAction = {
			type: "action",
			connector: DISCORD_CONNECTOR_ID,
			workspaceId: "guild_1",
			channelId: "conv_1",
			messageId: "msg_3",
			actionToken: "approval:abc",
			actor: { id: "user_2", displayName: "Ada" },
			replyHandle: "app_1/interaction-token",
		}
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			yield* transport.whisper(click, [{ kind: "prose", markdown: "only you" }])

			expect(http.seen[0].url).toBe("https://discord.com/api/v10/webhooks/app_1/interaction-token")
			expect(sentThreadBody(http.seen[0])).toMatchObject({ content: "only you", flags: 64 })

			// Without the interaction there is no way to show one person a message.
			const { replyHandle: _, ...unanswerable } = click
			const failure = yield* Effect.flip(transport.whisper(unanswerable, []))
			expect(failure.operation).toBe("whisper")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("waits out a 429 for exactly as long as it was asked to", () => {
		// `retry_after` is in seconds, fractional. Treating it as milliseconds would hammer a bot
		// straight into a longer ban.
		const http = stub([
			{ status: 429, body: '{"retry_after":2}' },
			{ status: 200, body: CREATED },
		])
		return Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				discordOutbound.transport.pipe(Effect.flatMap((transport) => transport.post(target, []))),
			)

			yield* TestClock.adjust("1 second")
			expect(http.seen).toHaveLength(1)

			yield* TestClock.adjust("1 second")
			yield* Fiber.join(fiber)
			expect(http.seen).toHaveLength(2)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("will not let a rate limit park a turn for as long as it likes", () => {
		// `retry_after` is a remote number reaching `Effect.sleep`; obeying it unbounded costs the
		// turn, so it is clamped and the attempt is spent instead.
		const http = stub([
			{ status: 429, body: '{"retry_after":86400}' },
			{ status: 200, body: CREATED },
		])
		return Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				discordOutbound.transport.pipe(Effect.flatMap((transport) => transport.post(target, []))),
			)

			yield* TestClock.adjust("30 seconds")
			yield* Fiber.join(fiber)
			expect(http.seen).toHaveLength(2)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("opens a thread on the anchor message and answers with the id to address it by", () => {
		const http = stub([{ status: 201, body: '{"id":"thread_7"}' }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const threadId = yield* transport.openThread({
				workspaceId: "guild_1",
				channelId: "conv_1",
				anchorMessageId: "msg_3",
				title: "t".repeat(140),
			})

			expect(threadId).toBe("thread_7")
			expect(http.seen[0].url).toBe(
				"https://discord.com/api/v10/channels/conv_1/messages/msg_3/threads",
			)
			// A thread name is 1–100 characters; over it, Discord rejects the request.
			expect(sentThreadBody(http.seen[0])).toEqual({
				name: "t".repeat(100),
				auto_archive_duration: 1440,
			})
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("names a thread the caller could not name, rather than sending a name Discord refuses", () => {
		const http = stub([{ status: 201, body: '{"id":"thread_8"}' }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			yield* transport.openThread({
				workspaceId: "guild_1",
				channelId: "conv_1",
				anchorMessageId: "msg_3",
				title: "   ",
			})

			// The limit is 1–100, so an empty name is a 400 and the answer never arrives.
			expect(sentThreadBody(http.seen[0]).name).toBe("Maple")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("addresses the thread once the turn is answering in one", () => {
		const http = stub([{ status: 200, body: CREATED }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			// A Discord thread IS a channel, so its id replaces the channel's everywhere.
			yield* transport.post({ ...target, threadId: "thread_7" }, [])

			expect(http.seen[0].url).toBe("https://discord.com/api/v10/channels/thread_7/messages")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("answers a mention in a thread of its own, keyed by the thread", () => {
		const http = stub([{ status: 201, body: '{"id":"thread_7"}' }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const conversation = yield* transport.conversation(mention)

			expect(conversation).toEqual({
				conversationKey: "thread_7",
				target: { workspaceId: "guild_1", channelId: "thread_7" },
				// The bot's own: what lets a later message in it be answered without a mention.
				opened: true,
			})
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("takes a channel that will not hold a thread as the conversation, but not as its own", () => {
		// What a channel the bot may not start threads in answers with.
		const http = stub([
			{ status: 403, body: '{"message":"Missing Permissions","code":50013}' },
			{ status: 200, body: '{"id":"conv_1","type":0}' },
		])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const conversation = yield* transport.conversation(mention)

			expect(conversation).toEqual({
				conversationKey: "conv_1",
				target: { workspaceId: "guild_1", channelId: "conv_1" },
				// NOT the bot's own. A channel it merely answers in never takes unaddressed messages,
				// which is the whole risk of this fallback.
				opened: false,
			})
			expect(http.seen[1].url).toBe("https://discord.com/api/v10/channels/conv_1")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("takes a thread it was mentioned in as its own conversation", () => {
		// What Discord answers for a thread started from a message that is already in one.
		const http = stub([
			{ status: 400, body: '{"message":"Cannot execute action on this channel type","code":50024}' },
			{ status: 200, body: '{"id":"conv_1","type":11}' },
		])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const conversation = yield* transport.conversation(mention)

			expect(conversation).toEqual({
				conversationKey: "conv_1",
				target: { workspaceId: "guild_1", channelId: "conv_1" },
				// The bot's own, so a follow-up in the thread is answered without a mention.
				opened: true,
			})
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("answers in the channel, mention-only, when its type cannot be read either", () => {
		const http = stub([
			{ status: 400, body: "{}" },
			{ status: 500, body: "{}" },
		])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const conversation = yield* transport.conversation(mention)

			expect(conversation.opened).toBe(false)
			expect(conversation.conversationKey).toBe("conv_1")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("opens nothing for a message that mentioned nobody, and makes no request", () => {
		const http = stub([{ status: 500, body: "{}" }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const conversation = yield* transport.conversation({ ...mention, mentionsBot: false })

			expect(conversation).toEqual({
				conversationKey: "conv_1",
				target: { workspaceId: "guild_1", channelId: "conv_1" },
				opened: false,
			})
			expect(http.seen).toEqual([])
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("reads the conversation's recent messages, newest first and bounded", () => {
		const page = JSON.stringify([
			{
				author: { id: "bot_1", username: "maple", bot: true },
				content: "Checkout is slow because of the payments call.",
				timestamp: "2026-09-23T12:00:20.000Z",
			},
			{
				author: { id: "user_2", username: "ada", global_name: "Ada" },
				member: { nick: "Ada L" },
				content: "why is checkout slow",
				timestamp: "2026-09-23T12:00:10.000Z",
			},
			// Undated, so it cannot be placed in the conversation at all.
			{ author: { id: "user_3", username: "bo" }, content: "hm", timestamp: "not a date" },
			// And one this connector cannot read at all — a message type Discord added, a field that
			// started arriving as something else. It costs itself, not the page around it.
			{ author: { id: 4 }, content: null },
		])
		const http = stub([{ status: 200, body: page }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const recent = yield* transport.history(target, { limit: 500, before: "msg_3" })

			expect(recent).toEqual([
				{
					displayName: "maple",
					isBot: true,
					text: "Checkout is slow because of the payments call.",
					at: Date.parse("2026-09-23T12:00:20.000Z"),
				},
				{
					// The server nickname wins over the global name, as it does everywhere else here.
					displayName: "Ada L",
					isBot: false,
					text: "why is checkout slow",
					at: Date.parse("2026-09-23T12:00:10.000Z"),
				},
			])
			// Discord's own ceiling, whatever the caller asked for.
			expect(http.seen[0].url).toBe(
				"https://discord.com/api/v10/channels/conv_1/messages?limit=100&before=msg_3",
			)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("reports a rejection as a typed failure carrying the status", () => {
		const http = stub([{ status: 403, body: '{"message":"Missing Access"}' }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const error = yield* Effect.flip(transport.edit({ target, messageId: "m1" }, []))

			expect(error).toBeInstanceOf(ChatOutboundError)
			expect(error).toMatchObject({
				connectorId: "discord",
				operation: "edit",
				status: 403,
				reason: "auth",
			})
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("names a token it will not honour, and gives an outage no reason", () => {
		const http = stub([
			{ status: 401, body: '{"message":"401: Unauthorized"}' },
			{ status: 502, body: "bad gateway" },
		])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			expect(yield* Effect.flip(transport.post(target, []))).toMatchObject({
				reason: "auth",
				status: 401,
			})
			const outage = yield* Effect.flip(transport.post(target, []))
			expect(outage.status).toBe(502)
			expect("reason" in outage).toBe(false)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("encodes a channel id before it reaches the path", () => {
		const http = stub([{ status: 200, body: CREATED }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			yield* transport.post({ workspaceId: "guild_1", channelId: "../guilds/guild_2" }, [])
			expect(http.seen[0].url).toBe(
				"https://discord.com/api/v10/channels/..%2Fguilds%2Fguild_2/messages",
			)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("names a channel that is gone and a message it would not take", () => {
		const http = stub([
			{ status: 404, body: '{"message":"Unknown Channel"}' },
			{ status: 400, body: '{"message":"Invalid Form Body"}' },
		])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			expect(yield* Effect.flip(transport.post(target, []))).toMatchObject({ reason: "not_found" })
			expect(yield* Effect.flip(transport.post(target, []))).toMatchObject({ reason: "rejected" })
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("lists a guild's text and announcement channels in the order Discord shows them", () => {
		const http = stub([
			{
				status: 200,
				body: JSON.stringify([
					{ id: "c_voice", type: 2, name: "standup", position: 0 },
					{ id: "c_news", type: 5, name: "announcements", position: 2 },
					{ id: "c_category", type: 4, name: "Engineering", position: 0 },
					{ id: "c_general", type: 0, name: "general", position: 1 },
				]),
			},
		])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const channels = yield* transport.destinations("guild_1")

			expect(channels).toEqual([
				{ id: "c_general", name: "general", private: false },
				{ id: "c_news", name: "announcements", private: false },
			])
			expect(http.seen[0].url).toBe("https://discord.com/api/v10/guilds/guild_1/channels")
			expect(http.seen[0].headers["authorization"]).toBe("Bot bot-token")
		}).pipe(Effect.provide(http.layer))
	})
})
