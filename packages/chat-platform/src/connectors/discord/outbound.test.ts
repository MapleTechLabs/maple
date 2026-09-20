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

const target = { conversationId: "conv_1" }

const CREATED = '{"id":"m1","channel_id":"conv_1"}'

describe("discord transport", () => {
	it.effect("authorizes as a bot and answers with the message it created", () => {
		const http = stub([{ status: 200, body: CREATED }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const ref = yield* transport.post(target, [{ kind: "prose", markdown: "hello" }])

			expect(ref).toEqual({ conversationId: "conv_1", messageId: "m1" })
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

	it.effect("reports a rejection as a typed failure carrying the status", () => {
		const http = stub([{ status: 403, body: '{"message":"Missing Access"}' }])
		return Effect.gen(function* () {
			const transport = yield* discordOutbound.transport
			const error = yield* Effect.flip(
				transport.edit({ conversationId: "conv_1", messageId: "m1" }, []),
			)

			expect(error).toBeInstanceOf(ChatOutboundError)
			expect(error).toMatchObject({ connectorId: "discord", operation: "edit", status: 403 })
		}).pipe(Effect.provide(http.layer))
	})
})
