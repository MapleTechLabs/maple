/**
 * The ingress end to end: a real signed HTTP request in, a response and normalized events out.
 *
 * Driven through `HttpServerRequest.fromWeb` rather than through the pieces, because the ordering
 * is the property under test — an unsigned body must not reach a decoder, and Slack must be
 * answered inside its own request whatever happened.
 */
import { createHmac } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { MAX_TIMESTAMP_SKEW_SECONDS, SIGNING_SECRET_CONFIG } from "./api"

/** The one thing a refused caller is ever told. */
const REJECTED = "Slack could not be verified as the sender of this request"
import { slackIngress } from "./webhook"

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5"

const config = new Map([[SIGNING_SECRET_CONFIG, SECRET]])

/** `it.effect` runs on a test clock that starts at the epoch, so that is what "now" is here. */
const NOW = 0

const sign = (timestamp: string, body: string) =>
	`v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`, "utf8").digest("hex")}`

const call = (
	body: string,
	options: {
		readonly contentType?: string
		readonly headers?: Record<string, string>
		readonly signature?: string
		readonly timestamp?: string
	} = {},
) => {
	const timestamp = options.timestamp ?? String(Math.floor(NOW / 1000))
	const request = HttpServerRequest.fromWeb(
		new Request("https://chat.maple.test/connectors/slack/webhook", {
			method: "POST",
			headers: {
				"content-type": options.contentType ?? "application/json",
				"x-slack-request-timestamp": timestamp,
				"x-slack-signature": options.signature ?? sign(timestamp, body),
				...options.headers,
			},
			body,
		}),
	)
	return slackIngress.handle(request, config)
}

const mention = JSON.stringify({
	token: "z26uFbvR1xHJEdHE1OQiO6t8",
	team_id: "T061EG9R6",
	api_app_id: "A0MDYCDME",
	type: "event_callback",
	event_id: "Ev0MDYGDKJ",
	event: {
		type: "app_mention",
		user: "U061F7AUR",
		text: "<@U0LAN0Z89> why is checkout slow?",
		ts: "1515449522.000016",
		channel: "C0LAN2Q65",
	},
	authorizations: [{ team_id: "T061EG9R6", user_id: "U0LAN0Z89", is_bot: true }],
})

describe("slack webhook ingress", () => {
	it.effect("answers the URL-verification handshake with the challenge itself", () =>
		Effect.gen(function* () {
			const body = JSON.stringify({ type: "url_verification", challenge: "abc123", token: "t" })
			const result = yield* call(body)
			expect(result.events).toEqual([])
			expect(result.response.status).toBe(200)
			const text = result.response.body
			expect(text._tag === "Uint8Array" && new TextDecoder().decode(text.body)).toBe("abc123")
		}),
	)

	it.effect("accepts a signed mention and hands it back as a normalized event", () =>
		Effect.gen(function* () {
			const result = yield* call(mention)
			expect(result.response.status).toBe(200)
			expect(result.events).toEqual([
				{
					type: "message",
					connector: "slack",
					workspaceId: "T061EG9R6",
					channelId: "C0LAN2Q65",
					threadId: "1515449522.000016",
					messageId: "1515449522.000016",
					author: { id: "U061F7AUR", displayName: "U061F7AUR", isBot: false },
					text: "why is checkout slow?",
					mentionsBot: true,
				},
			])
		}),
	)

	it.effect("refuses a body that does not match its signature, and reads nothing out of it", () =>
		Effect.gen(function* () {
			const error = yield* call(mention, { signature: `v0=${"0".repeat(64)}` }).pipe(Effect.flip)
			expect(error._tag).toBe("@maple/chat-platform/ConnectorIngressError")
			expect(error.message).toBe(REJECTED)
		}),
	)

	it.effect("refuses a correctly signed body that is too old to be live", () =>
		Effect.gen(function* () {
			const stale = String(MAX_TIMESTAMP_SKEW_SECONDS + 60)
			const error = yield* call(mention, { timestamp: stale }).pipe(Effect.flip)
			expect(error.message).toBe(REJECTED)
		}),
	)

	it.effect("tells a refused caller nothing about which check refused it", () =>
		Effect.gen(function* () {
			// The host returns this message as the 400 body. Naming the failing check tells an
			// attacker which one to fix; the reason goes on the span instead.
			const reasons = ["signature", "timestamp", "mismatch", "malformed", "stale", "missing"]
			for (const options of [
				{ signature: `v0=${"0".repeat(64)}` },
				{ signature: "not-a-signature" },
				{ timestamp: String(MAX_TIMESTAMP_SKEW_SECONDS + 60) },
				{ timestamp: "not-a-timestamp" },
			]) {
				const error = yield* call(mention, options).pipe(Effect.flip)
				expect(error.message).toBe(REJECTED)
				for (const reason of reasons) expect(error.message.toLowerCase()).not.toContain(reason)
			}
		}),
	)

	it.effect("does not echo the challenge of an UNSIGNED handshake", () =>
		Effect.gen(function* () {
			// The one branch that puts request content in the response. If verification ran after
			// parsing, this would answer 200 with the challenge and Slack would accept any URL.
			const body = JSON.stringify({ type: "url_verification", challenge: "abc123", token: "t" })
			const error = yield* call(body, { signature: `v0=${"0".repeat(64)}` }).pipe(Effect.flip)
			expect(error._tag).toBe("@maple/chat-platform/ConnectorIngressError")
			expect(error.message).not.toContain("abc123")
		}),
	)

	it.effect("acknowledges a redelivery and relays nothing, so one question is answered once", () =>
		Effect.gen(function* () {
			const result = yield* call(mention, { headers: { "x-slack-retry-num": "1" } })
			expect(result.response.status).toBe(200)
			expect(result.events).toEqual([])
		}),
	)

	it.effect("reads a button press out of the form-encoded interactivity body", () =>
		Effect.gen(function* () {
			const payload = JSON.stringify({
				type: "block_actions",
				team: { id: "T061EG9R6" },
				user: { id: "U061F7AUR", name: "ada" },
				container: { type: "message", message_ts: "1515449522.000016", channel_id: "C0LAN2Q65" },
				message: { ts: "1515449522.000016", thread_ts: "1515449400.000001" },
				actions: [{ action_id: "maple_approve", value: "sess-1|call-1" }],
			})
			const body = new URLSearchParams({ payload }).toString()
			const result = yield* call(body, { contentType: "application/x-www-form-urlencoded" })
			expect(result.events).toEqual([
				{
					type: "action",
					connector: "slack",
					workspaceId: "T061EG9R6",
					channelId: "C0LAN2Q65",
					threadId: "1515449400.000001",
					messageId: "1515449522.000016",
					actionToken: "sess-1|call-1",
					actor: { id: "U061F7AUR", displayName: "ada" },
				},
			])
		}),
	)

	it.effect("acknowledges an interaction that is not one of Maple's without relaying it", () =>
		Effect.gen(function* () {
			const payload = JSON.stringify({ type: "view_submission", user: { id: "U1" } })
			const body = new URLSearchParams({ payload }).toString()
			const result = yield* call(body, { contentType: "application/x-www-form-urlencoded" })
			expect(result.response.status).toBe(200)
			expect(result.events).toEqual([])
		}),
	)

	it.effect("acknowledges a signed event it has no mapping for", () =>
		Effect.gen(function* () {
			const body = JSON.stringify({
				team_id: "T061EG9R6",
				type: "event_callback",
				event: { type: "reaction_added", user: "U1", channel: "C1", ts: "1.0" },
			})
			const result = yield* call(body)
			expect(result.response.status).toBe(200)
			expect(result.events).toEqual([])
		}),
	)

	it.effect("refuses a request when the deployment holds no signing secret", () =>
		Effect.gen(function* () {
			const request = HttpServerRequest.fromWeb(
				new Request("https://chat.maple.test/connectors/slack/webhook", {
					method: "POST",
					body: mention,
				}),
			)
			const error = yield* slackIngress.handle(request, new Map()).pipe(Effect.flip)
			expect(error.message).toContain("no signing secret")
		}),
	)
})
