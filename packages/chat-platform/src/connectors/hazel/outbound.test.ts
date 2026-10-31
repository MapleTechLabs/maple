/**
 * The transport against a stubbed HTTP client: the requests Hazel's bot API expects, a 429 waited
 * out, and the conversation a mention opens.
 */
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"
import type { InboundAction, InboundMessage } from "../../ingress"
import { ConnectorCredentials } from "../../outbound"
import { BOT_TOKEN_CONFIG } from "./api"
import { HAZEL_CONNECTOR_ID } from "./id"
import { hazelOutbound, headerRetryAfter } from "./outbound"

interface Reply {
	readonly status: number
	readonly body: string
}

/** Answers each request with the first reply whose route prefix it matches. */
const stub = (routes: ReadonlyArray<readonly [string, Reply | ReadonlyArray<Reply>]>) => {
	const seen: Array<HttpClientRequest.HttpClientRequest> = []
	const counts = new Map<string, number>()
	const client = HttpClient.make((request) => {
		seen.push(request)
		const path = request.url.replace("https://api.hazel.sh/api/v1", "")
		const [prefix, replies] = routes.find(([route]) => path.startsWith(route)) ?? [
			"",
			{ status: 500, body: "" },
		]
		const list = Array.isArray(replies) ? replies : [replies as Reply]
		const index = counts.get(prefix) ?? 0
		counts.set(prefix, index + 1)
		const reply = list[Math.min(index, list.length - 1)]!
		return Effect.succeed(
			HttpClientResponse.fromWeb(request, new Response(reply.body, { status: reply.status })),
		)
	})
	return {
		seen,
		layer: Layer.mergeAll(
			Layer.succeed(HttpClient.HttpClient)(client),
			Layer.succeed(ConnectorCredentials)(
				Effect.succeed(new Map([[BOT_TOKEN_CONFIG, "hzl_bot_token"]])),
			),
		),
	}
}

/** A request's JSON body, compared whole against what the test expects. */
type SentBody = Readonly<Record<string, unknown>>

const sentBody = (request: HttpClientRequest.HttpClientRequest | undefined): SentBody => {
	const body = request?.body
	if (body?._tag !== "Uint8Array") throw new Error("the request carried no JSON body")
	// SAFETY: the body under test is one this transport just wrote; a wrong shape fails the assertion.
	return JSON.parse(new TextDecoder().decode(body.body)) as SentBody
}

const ORG = "33333333-3333-4333-8333-333333333333"
const CHANNEL = "44444444-4444-4444-8444-444444444444"
const THREAD = "66666666-6666-4666-8666-666666666666"
const ADA = "22222222-2222-4222-8222-222222222222"
const BOT = "11111111-1111-4111-8111-111111111111"
const target = { workspaceId: ORG, channelId: THREAD }

const mention: InboundMessage = {
	type: "message",
	connector: HAZEL_CONNECTOR_ID,
	workspaceId: ORG,
	channelId: CHANNEL,
	messageId: "m-question",
	author: { id: ADA, displayName: "Ada", isBot: false },
	text: "why is checkout slow",
	mentionsBot: true,
}

describe("retry-after header", () => {
	const now = Date.parse("2026-10-31T10:00:00.000Z")
	it("reads seconds and HTTP-dates, and never reads blank or past as zero", () => {
		expect(Duration.toMillis(headerRetryAfter("3", now))).toBe(3000)
		expect(Duration.toMillis(headerRetryAfter("Sat, 31 Oct 2026 10:00:05 GMT", now))).toBe(5000)
		for (const value of [undefined, "", "  ", "soon", "Sat, 31 Oct 2026 09:00:00 GMT"]) {
			expect(Duration.toMillis(headerRetryAfter(value, now))).toBe(1000)
		}
	})
})

describe("hazel transport", () => {
	it.effect("posts as the bot, and edits the message in its channel", () => {
		const http = stub([
			["/messages", { status: 200, body: JSON.stringify({ data: { id: "m1" }, transactionId: "t" }) }],
		])
		return Effect.gen(function* () {
			const transport = yield* hazelOutbound.transport
			const ref = yield* transport.post(target, [{ kind: "prose", markdown: "hello" }])
			expect(ref).toEqual({ target, messageId: "m1" })
			yield* transport.edit(ref, [{ kind: "prose", markdown: "hello again" }])
			const [post, edit] = http.seen
			expect(post?.headers["authorization"]).toBe("Bearer hzl_bot_token")
			expect(sentBody(post)).toEqual({
				channelId: THREAD,
				content: "hello",
				embeds: null,
				replyToMessageId: null,
				threadChannelId: null,
			})
			expect([edit?.method, edit?.url]).toEqual(["PATCH", "https://api.hazel.sh/api/v1/messages/m1"])
			expect(sentBody(edit)).toEqual({ channelId: THREAD, content: "hello again", embeds: null })
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("waits out a 429 for as long as Hazel asks", () => {
		const http = stub([
			[
				"/messages",
				[
					{
						status: 429,
						body: JSON.stringify({ _tag: "RateLimitExceededError", retryAfterMs: 2000 }),
					},
					{ status: 200, body: JSON.stringify({ data: { id: "m1" } }) },
				],
			],
		])
		return Effect.gen(function* () {
			const transport = yield* hazelOutbound.transport
			const fiber = yield* Effect.forkChild(transport.post(target, []))
			yield* TestClock.adjust("2 seconds")
			expect((yield* Fiber.join(fiber)).messageId).toBe("m1")
			expect(http.seen).toHaveLength(2)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("answers a mention in a thread on it, keyed without dashes", () => {
		const http = stub([["/channels/", { status: 200, body: JSON.stringify({ data: { id: THREAD } }) }]])
		return Effect.gen(function* () {
			const transport = yield* hazelOutbound.transport
			const conversation = yield* transport.conversation(mention)
			expect(conversation).toEqual({
				conversationKey: THREAD.replaceAll("-", ""),
				target: { workspaceId: ORG, channelId: THREAD },
				opened: true,
			})
			expect(http.seen[0]?.url).toBe(`https://api.hazel.sh/api/v1/channels/${CHANNEL}/threads`)
			expect(sentBody(http.seen[0])).toEqual({ messageId: "m-question" })
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("opens nothing for a press or an unaddressed message, and falls back to the channel", () => {
		const http = stub([["/channels/", { status: 403, body: "" }]])
		return Effect.gen(function* () {
			const transport = yield* hazelOutbound.transport
			const press: InboundAction = {
				type: "action",
				connector: HAZEL_CONNECTOR_ID,
				workspaceId: ORG,
				channelId: THREAD,
				messageId: "m1",
				actionToken: "approve:call_1",
				actor: { id: ADA, displayName: "Ada" },
			}
			expect((yield* transport.conversation(press)).opened).toBe(false)
			expect((yield* transport.conversation({ ...mention, mentionsBot: false })).target.channelId).toBe(
				CHANNEL,
			)
			expect(http.seen).toHaveLength(0)
			const refused = yield* transport.conversation(mention)
			expect(refused).toMatchObject({ target: { channelId: CHANNEL }, opened: false })
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("reads history newest first with its authors' names and mentions as names", () => {
		const http = stub([
			[
				"/messages",
				{
					status: 200,
					body: JSON.stringify({
						data: [
							{
								id: "m2",
								authorId: BOT,
								content: "Looking.",
								createdAt: "2026-10-31T10:01:00.000Z",
							},
							{
								id: "m1",
								authorId: ADA,
								content: `@[userId:${BOT}] is checkout ok?`,
								createdAt: "2026-10-31T10:00:00.000Z",
							},
						],
						has_more: false,
					}),
				},
			],
			[
				"/organizations/",
				{
					status: 200,
					body: JSON.stringify({
						data: [
							{ id: ADA, displayName: "Ada", avatarUrl: null, isBot: false },
							{ id: BOT, displayName: "Maple", avatarUrl: null, isBot: true },
						],
					}),
				},
			],
		])
		return Effect.gen(function* () {
			const transport = yield* hazelOutbound.transport
			const history = yield* transport.history(target, { limit: 20, before: "m3" })
			expect(history).toEqual([
				{
					displayName: "Maple",
					isBot: true,
					text: "Looking.",
					at: Date.parse("2026-10-31T10:01:00.000Z"),
				},
				{
					displayName: "Ada",
					isBot: false,
					text: "@Maple is checkout ok?",
					at: Date.parse("2026-10-31T10:00:00.000Z"),
				},
			])
			expect(http.seen[0]?.url).toBe(
				`https://api.hazel.sh/api/v1/messages?channel_id=${THREAD}&starting_after=m3&limit=20`,
			)
			expect(http.seen[1]?.url).toContain(`/organizations/${ORG}/users?ids=`)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("keeps the history when the names cannot be read, and never waits out a 429 for it", () => {
		const page = JSON.stringify({
			data: [
				{
					id: "m1",
					authorId: ADA,
					content: "is checkout ok?",
					createdAt: "2026-10-31T10:00:00.000Z",
				},
			],
			has_more: false,
		})
		const http = stub([
			[
				"/messages",
				[
					{ status: 200, body: page },
					{ status: 429, body: JSON.stringify({ retryAfterMs: 5000 }) },
				],
			],
			["/organizations/", { status: 403, body: "" }],
		])
		return Effect.gen(function* () {
			const transport = yield* hazelOutbound.transport
			const history = yield* transport.history(target, { limit: 20, before: "m3" })
			expect(history).toEqual([
				{
					displayName: "Someone",
					isBot: false,
					text: "is checkout ok?",
					at: Date.parse("2026-10-31T10:00:00.000Z"),
				},
			])
			const limited = yield* Effect.flip(transport.history(target, { limit: 20, before: "m3" }))
			expect(limited.status).toBe(429)
			expect(http.seen.filter((request) => request.url.includes("/messages?"))).toHaveLength(2)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("whispers by mentioning the person who pressed", () => {
		const http = stub([["/messages", { status: 200, body: JSON.stringify({ data: { id: "m9" } }) }]])
		return Effect.gen(function* () {
			const transport = yield* hazelOutbound.transport
			yield* transport.whisper(
				{
					type: "action",
					connector: HAZEL_CONNECTOR_ID,
					workspaceId: ORG,
					channelId: THREAD,
					messageId: "m1",
					actionToken: "approve:call_1",
					actor: { id: ADA, displayName: "Ada" },
				},
				[{ kind: "notice", tone: "info", text: "Already decided." }],
			)
			expect(sentBody(http.seen[0])).toMatchObject({
				channelId: THREAD,
				content: `@[userId:${ADA}] _Already decided._`,
			})
		}).pipe(Effect.provide(http.layer))
	})
})
