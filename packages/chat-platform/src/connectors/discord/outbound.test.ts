/**
 * The transport against a stubbed HTTP client — what a real Discord cannot be asked to reproduce
 * on demand: a 429, and a rejection that has to reach the driver as a typed failure.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import type { InboundMessage } from "../../ingress"
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
			Layer.succeed(ConnectorCredentials)(new Map([[BOT_TOKEN_CONFIG, "bot-token"]])),
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

const parentChannelOf = () =>
	discordOutbound.transport.pipe(Effect.flatMap((transport) => transport.parentChannel(target)))

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
			})
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("takes a channel that will not hold a thread as the conversation itself", () => {
		// What a mention already inside a thread answers with, and what a channel the bot may not
		// start threads in answers with. Either way the mention's own channel is the conversation.
		const http = stub([{ status: 400, body: '{"message":"Cannot start a thread here"}' }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const conversation = yield* transport.conversation(mention)

			expect(conversation).toEqual({
				conversationKey: "conv_1",
				target: { workspaceId: "guild_1", channelId: "conv_1" },
			})
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("asks which channel a thread was started in, so a channel list covers its threads", () => {
		// Type 11: a public thread, whose `parent_id` is the text channel it was started in.
		const http = stub([{ status: 200, body: '{"id":"conv_1","type":11,"parent_id":"channel_4"}' }])
		return Effect.gen(function* () {
			const parent = yield* parentChannelOf()

			expect(parent).toBe("channel_4")
			expect(http.seen[0].url).toBe("https://discord.com/api/v10/channels/conv_1")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("never takes an ordinary channel's category as its parent", () => {
		// Type 0 with a `parent_id`: a text channel filed under a category. Reading that as a parent
		// would let one category id in a workspace's channel list cover every channel beneath it.
		const http = stub([{ status: 200, body: '{"id":"conv_1","type":0,"parent_id":"category_2"}' }])
		return Effect.gen(function* () {
			expect(yield* parentChannelOf()).toBeUndefined()
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("reports a channel it could not read rather than answering that it has no parent", () => {
		// The two are different answers: one says "check this channel itself", the other says Discord
		// did not say — and a caller that read them the same way would answer in a channel on a 403.
		const http = stub([{ status: 403, body: '{"message":"Missing Access"}' }])
		return Effect.gen(function* () {
			const failure = yield* Effect.flip(parentChannelOf())

			expect(failure.operation).toBe("channel")
			expect(failure.status).toBe(403)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("reports a rejection as a typed failure carrying the status", () => {
		const http = stub([{ status: 403, body: '{"message":"Missing Access"}' }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const error = yield* Effect.flip(transport.edit({ target, messageId: "m1" }, []))

			expect(error).toBeInstanceOf(ChatOutboundError)
			expect(error).toMatchObject({ connectorId: "discord", operation: "edit", status: 403 })
		}).pipe(Effect.provide(http.layer))
	})
})
