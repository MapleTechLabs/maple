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

const CREDENTIALS = encodeSlackCredentials({
	bot_token: "xoxb-a-workspaces-own-token",
	bot_user_id: "U0KRQLJ9H",
})

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

	it.effect("names a conversation by channel and thread, and makes no call to do it", () => {
		const http = stub([{ status: 200, body: POSTED }])
		return Effect.gen(function* () {
			const transport = yield* slackOutbound.transport
			const conversation = yield* transport.conversation(mention)
			expect(conversation).toEqual({
				conversationKey: "C1:1700000000.000100",
				target: { workspaceId: "T1", channelId: "C1", threadId: "1700000000.000100" },
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
})
