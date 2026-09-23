/**
 * The transport against a stubbed HTTP client — what a real Slack cannot be asked to reproduce on
 * demand: a 429, a 200 that means failure, and a workspace with no stored token at all.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http"
import type { InboundMessage } from "../../ingress"
import { ConnectorCredentials, WORKSPACE_CREDENTIALS } from "../../outbound"
import { encodeSlackCredentials } from "./credentials"
import { SLACK_CONNECTOR_ID } from "./id"
import { slackOutbound } from "./outbound"

interface Attempt {
	readonly status: number
	readonly body: string
	readonly headers?: Record<string, string>
}

const CREDENTIALS = encodeSlackCredentials({ bot_token: "xoxb-a-workspaces-own-token" })

/** `null` credentials is a workspace nobody linked — deliberately not `undefined`, which a default
 * parameter would fill back in. */
const stub = (attempts: ReadonlyArray<Attempt>, credentials: string | null = CREDENTIALS) => {
	const seen: Array<HttpClientRequest.HttpClientRequest> = []
	const client = HttpClient.make((request) => {
		const attempt = attempts[Math.min(seen.length, attempts.length - 1)] ?? { status: 200, body: "{}" }
		seen.push(request)
		return Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				new Response(attempt.body, { status: attempt.status, headers: attempt.headers }),
			),
		)
	})
	const config = new Map<string, string>()
	if (credentials !== null) config.set(WORKSPACE_CREDENTIALS, credentials)
	return {
		seen,
		layer: Layer.mergeAll(
			Layer.succeed(HttpClient.HttpClient)(client),
			Layer.succeed(ConnectorCredentials)(config),
		),
	}
}

const target = { workspaceId: "T1", channelId: "C1", threadId: "1700000000.000100" }

/** The JSON body a request carried. */
const sentBody = (request: HttpClientRequest.HttpClientRequest): Record<string, unknown> => {
	const body = request.body
	if (body._tag !== "Uint8Array") throw new Error("the request carried no JSON body")
	// SAFETY: the body under test is the one the transport just wrote; a wrong one fails the
	// assertion it feeds rather than escaping as a bad type.
	return JSON.parse(new TextDecoder().decode(body.body)) as Record<string, unknown>
}

const POSTED = '{"ok":true,"channel":"C1","ts":"1700000000.000200"}'

const mention: InboundMessage = {
	type: "message",
	connector: SLACK_CONNECTOR_ID,
	workspaceId: "T1",
	channelId: "C1",
	threadId: "1700000000.000100",
	messageId: "1700000000.000100",
	author: { id: "U1", displayName: "U1", isBot: false },
	text: "why is checkout slow",
	mentionsBot: true,
}

describe("slack transport", () => {
	it.effect("posts with the workspace's own token, in the thread it was asked in", () => {
		const http = stub([{ status: 200, body: POSTED }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const ref = yield* transport.post(target, [{ kind: "prose", markdown: "hello" }])

			expect(ref).toEqual({ target, messageId: "1700000000.000200" })
			expect(http.seen[0]?.headers["authorization"]).toBe("Bearer xoxb-a-workspaces-own-token")
			expect(sentBody(http.seen[0]!)).toMatchObject({
				channel: "C1",
				thread_ts: "1700000000.000100",
				text: "hello",
			})
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("names no thread on a target that has none", () => {
		const http = stub([{ status: 200, body: POSTED }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			yield* transport.post({ workspaceId: "T1", channelId: "C1" }, [
				{ kind: "prose", markdown: "hello" },
			])
			expect("thread_ts" in sentBody(http.seen[0]!)).toBe(false)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("edits by the message's own timestamp", () => {
		const http = stub([{ status: 200, body: POSTED }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			yield* transport.edit({ target, messageId: "1700000000.000200" }, [
				{ kind: "prose", markdown: "revised" },
			])
			expect(http.seen[0]?.url).toContain("chat.update")
			expect(sentBody(http.seen[0]!)).toMatchObject({ channel: "C1", ts: "1700000000.000200" })
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("refuses to post for a workspace with no stored token, before making a request", () => {
		const http = stub([{ status: 200, body: POSTED }], null)
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const failure = yield* transport
				.post(target, [{ kind: "prose", markdown: "hello" }])
				.pipe(Effect.flip)
			expect(failure.message).toContain("not connected to Maple")
			expect(http.seen).toHaveLength(0)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("waits out a rate limit Slack reported with a 200, in either spelling", () => {
		const http = stub([
			{ status: 200, body: '{"ok":false,"error":"rate_limited"}' },
			{ status: 200, body: '{"ok":false,"error":"ratelimited"}' },
			{ status: 200, body: POSTED },
		])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const running = yield* Effect.forkChild(
				transport.post(target, [{ kind: "prose", markdown: "x" }]),
			)
			// No `Retry-After` on a 200, so each attempt waits the default second.
			yield* TestClock.adjust("2 seconds")
			expect(yield* Fiber.join(running)).toMatchObject({ messageId: "1700000000.000200" })
			expect(http.seen).toHaveLength(3)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("clamps a rate limit that asks for longer than a turn can wait", () => {
		const http = stub([
			{ status: 429, body: "{}", headers: { "retry-after": "600" } },
			{ status: 200, body: POSTED },
		])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const running = yield* Effect.forkChild(
				transport.post(target, [{ kind: "prose", markdown: "x" }]),
			)
			// Ten minutes asked for, thirty seconds honoured.
			yield* TestClock.adjust("30 seconds")
			expect(yield* Fiber.join(running)).toMatchObject({ messageId: "1700000000.000200" })
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("falls back to a default wait when Retry-After is not a number", () => {
		const http = stub([
			{ status: 429, body: "{}", headers: { "retry-after": "soon" } },
			{ status: 200, body: POSTED },
		])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const running = yield* Effect.forkChild(
				transport.post(target, [{ kind: "prose", markdown: "x" }]),
			)
			yield* TestClock.adjust("1 second")
			expect(yield* Fiber.join(running)).toMatchObject({ messageId: "1700000000.000200" })
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("reports an HTTP failure and an unreadable reply as this operation's failure", () => {
		const http = stub([{ status: 500, body: "upstream is unwell" }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const failure = yield* transport
				.post(target, [{ kind: "prose", markdown: "x" }])
				.pipe(Effect.flip)
			expect(failure.status).toBe(500)
			expect(failure.operation).toBe("post")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("fails the post when Slack answers ok with no timestamp to edit later", () => {
		const http = stub([{ status: 200, body: '{"ok":true,"channel":"C1"}' }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const failure = yield* transport
				.post(target, [{ kind: "prose", markdown: "x" }])
				.pipe(Effect.flip)
			expect(failure.message).toContain("no message timestamp")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("reads Slack's 200-with-ok-false as the failure it is", () => {
		const http = stub([{ status: 200, body: '{"ok":false,"error":"channel_not_found"}' }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const failure = yield* transport
				.post(target, [{ kind: "prose", markdown: "hello" }])
				.pipe(Effect.flip)
			expect(failure.message).toContain("channel_not_found")
			expect(failure.operation).toBe("post")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("waits out a 429 for as long as Slack asked, then posts", () => {
		const http = stub([
			{ status: 429, body: '{"ok":false,"error":"ratelimited"}', headers: { "retry-after": "3" } },
			{ status: 200, body: POSTED },
		])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const running = yield* Effect.forkChild(
				transport.post(target, [{ kind: "prose", markdown: "x" }]),
			)
			yield* TestClock.adjust("2 seconds")
			expect(http.seen).toHaveLength(1)
			yield* TestClock.adjust("1 second")
			expect(yield* Fiber.join(running)).toMatchObject({ messageId: "1700000000.000200" })
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("gives up rather than waiting out a rate limit forever", () => {
		const http = stub([{ status: 429, body: "{}", headers: { "retry-after": "1" } }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const running = yield* Effect.forkChild(
				transport.post(target, [{ kind: "prose", markdown: "x" }]).pipe(Effect.flip),
			)
			yield* TestClock.adjust("1 minute")
			const failure = yield* Fiber.join(running)
			expect(failure.status).toBe(429)
			expect(http.seen).toHaveLength(3)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("shows nothing for typing, because Slack has nothing to show", () => {
		const http = stub([{ status: 200, body: POSTED }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			yield* transport.typing(target)
			expect(http.seen).toHaveLength(0)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("opens a thread without asking Slack — a thread is just replies to a message", () => {
		const http = stub([{ status: 200, body: POSTED }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const threadId = yield* transport.openThread({
				workspaceId: "T1",
				channelId: "C1",
				anchorMessageId: "1700000000.000100",
				title: "why is checkout slow",
			})
			expect(threadId).toBe("1700000000.000100")
			expect(http.seen).toHaveLength(0)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("reads a thread's replies, newest first, bounded by the message asked about", () => {
		const http = stub([
			{
				status: 200,
				// Slack answers a thread OLDEST first. The contract wants the other order, and the
				// bound has to cut the oldest — so the page is sorted here rather than trusted.
				body: JSON.stringify({
					ok: true,
					messages: [
						{ ts: "1700000000.000100", user: "U1", text: "first" },
						{ ts: "1700000000.000200", bot_id: "B1", username: "Maple", text: "answer" },
						{ ts: "1700000000.000300", user: "U2", text: "third" },
					],
				}),
			},
		])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const history = yield* transport.history(target, { limit: 10, before: "1700000000.000400" })

			// All three fall in the same SECOND, so they order by the `ts` and not by the epoch-ms
			// the contract carries — which is the whole reason the sort does not use `at`.
			expect(history).toEqual([
				{ displayName: "U2", isBot: false, text: "third", at: 1_700_000_000_000 },
				// Maple's own answers come back too, and the model is told which lines are its.
				{ displayName: "Maple", isBot: true, text: "answer", at: 1_700_000_000_000 },
				{ displayName: "U1", isBot: false, text: "first", at: 1_700_000_000_000 },
			])
			expect(http.seen[0]?.url).toContain("conversations.replies")
			expect(sentBody(http.seen[0]!)).toEqual({
				channel: "C1",
				limit: 10,
				latest: "1700000000.000400",
				inclusive: false,
				// The thread is addressed by its parent's `ts`.
				ts: "1700000000.000100",
			})
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("reads a channel when the conversation is not a thread", () => {
		const http = stub([{ status: 200, body: '{"ok":true,"messages":[]}' }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			yield* transport.history(
				{ workspaceId: "T1", channelId: "C1" },
				{
					limit: 5,
					before: "1700000000.000400",
				},
			)
			expect(http.seen[0]?.url).toContain("conversations.history")
			expect("ts" in sentBody(http.seen[0]!)).toBe(false)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("holds the request to Slack's own ceiling however much was asked for", () => {
		const http = stub([{ status: 200, body: '{"ok":true,"messages":[]}' }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			yield* transport.history(target, { limit: 100_000, before: "1700000000.000400" })
			expect(sentBody(http.seen[0]!)).toMatchObject({ limit: 200 })
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("loses one unreadable message rather than the conversation around it", () => {
		const http = stub([
			{
				status: 200,
				body: JSON.stringify({
					ok: true,
					messages: [
						{ ts: "1700000000.000100", user: "U1", text: "kept" },
						// No `ts` at all, and a `ts` that is not one: neither can be dated.
						{ user: "U2", text: "no timestamp" },
						{ ts: "not-a-timestamp", user: "U3", text: "bad timestamp" },
						// No text is still a message; the host leaves it out of the context.
						{ ts: "1700000000.000400", user: "U4" },
					],
				}),
			},
		])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const history = yield* transport.history(target, { limit: 10, before: "1700000000.000500" })
			expect(history.map((message) => message.text)).toEqual(["", "kept"])
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("reports a refused history read as this operation's failure", () => {
		const http = stub([{ status: 200, body: '{"ok":false,"error":"not_in_channel"}' }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const failure = yield* transport
				.history(target, { limit: 10, before: "1700000000.000400" })
				.pipe(Effect.flip)
			expect(failure.operation).toBe("history")
			expect(failure.message).toContain("not_in_channel")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("names a conversation by channel and thread, and makes no call to do it", () => {
		const http = stub([{ status: 200, body: POSTED }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const conversation = yield* transport.conversation(mention)
			expect(conversation).toEqual({
				conversationKey: "C1:1700000000.000100",
				target: { workspaceId: "T1", channelId: "C1", threadId: "1700000000.000100" },
				opened: true,
			})
			expect(http.seen).toHaveLength(0)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("answers a top-level mention in a thread of its own message", () => {
		const http = stub([{ status: 200, body: POSTED }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const { threadId: _dropped, ...topLevel } = mention
			const conversation = yield* transport.conversation(topLevel)
			// The mention's own `ts` becomes the thread, so the answer sits under the question.
			expect(conversation.target.threadId).toBe("1700000000.000100")
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("reports a top-level mention as a conversation the bot opened", () => {
		const http = stub([{ status: 200, body: POSTED }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			// A Slack thread begins with the first reply carrying the parent's `ts`, so answering a
			// top-level mention is what creates it — and ingress names the thread by that same `ts`.
			const topLevel = { ...mention, messageId: "1700000000.000100" }
			expect((yield* transport.conversation(topLevel)).opened).toBe(true)
			expect(http.seen).toHaveLength(0)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("reports a mention inside an existing thread as one it did not open", () => {
		const http = stub([{ status: 200, body: POSTED }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const inThread = { ...mention, messageId: "1700000000.000900" }
			expect((yield* transport.conversation(inThread)).opened).toBe(false)
		}).pipe(Effect.provide(http.layer))
	})

	it.effect("opens nothing for a message that addressed nobody", () => {
		const http = stub([{ status: 200, body: POSTED }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			// An unaddressed follow-up can only ever continue a conversation that already exists.
			const followUp = { ...mention, mentionsBot: false, messageId: "1700000000.000100" }
			expect((yield* transport.conversation(followUp)).opened).toBe(false)
		}).pipe(Effect.provide(http.layer))
	})
})
