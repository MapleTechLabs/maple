/**
 * The transport against a stubbed HTTP client — what a real Discord cannot be asked to reproduce
 * on demand: a 429, and a rejection that has to reach the driver as a typed failure.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Redacted } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import { ChatOutboundError } from "../../outbound"
import { DiscordBotToken, discordOutbound } from "./outbound"

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
			Layer.succeed(DiscordBotToken)(Redacted.make("bot-token")),
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

	it.effect("addresses the thread once the turn is answering in one", () => {
		const http = stub([{ status: 200, body: CREATED }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			// A Discord thread IS a channel, so its id replaces the channel's everywhere.
			yield* transport.post({ ...target, threadId: "thread_7" }, [])

			expect(http.seen[0].url).toBe("https://discord.com/api/v10/channels/thread_7/messages")
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
