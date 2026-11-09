import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { jsonResponse, testEnv } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { SupportSlackClient } from "./SupportSlackClient"

/** The client over a Slack that answers every call with `body`. */
const slackAnswering = (body: unknown) =>
	Layer.effect(SupportSlackClient, SupportSlackClient.make).pipe(
		Layer.provide(
			Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
					Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(body))),
				),
			),
		),
		Layer.provide(testEnv({ MAPLE_SUPPORT_SLACK_BOT_TOKEN: "xoxb-test" })),
	)

describe("SupportSlackClient", () => {
	// chat.postMessage names the channel by id only; failing to read that once
	// made a delivered cancellation report look unsent, and every retry posted it again.
	it.effect("reads a chat.postMessage answer, whose channel is a bare id", () =>
		Effect.gen(function* () {
			const slack = yield* SupportSlackClient
			const answer = yield* slack.call("chat.postMessage", { channel: "C123", text: "hi" })
			assert.isTrue(answer.ok)
			assert.strictEqual(answer.channel, "C123")
		}).pipe(
			Effect.provide(
				slackAnswering({
					ok: true,
					channel: "C123",
					ts: "1729600000.000100",
					message: { text: "hi" },
				}),
			),
		),
	)

	it.effect("reads a conversations.create answer, whose channel is an object", () =>
		Effect.gen(function* () {
			const slack = yield* SupportSlackClient
			const answer = yield* slack.call("conversations.create", { name: "maple-acme" })
			assert.deepStrictEqual(answer.channel, { id: "C9", name: "maple-acme" })
		}).pipe(
			Effect.provide(
				slackAnswering({ ok: true, channel: { id: "C9", name: "maple-acme", is_private: false } }),
			),
		),
	)

	// `invalid_blocks` alone never said which block; Slack's messages do.
	it.effect("keeps Slack's account of a refusal, which names the offending block", () =>
		Effect.gen(function* () {
			const slack = yield* SupportSlackClient
			const refused = yield* slack
				.call("chat.postMessage", { channel: "C123", text: "hi" })
				.pipe(Effect.flip)
			assert.strictEqual(refused._tag, "@maple/backend/support/SupportSlackRefusedError")
			if (refused._tag !== "@maple/backend/support/SupportSlackRefusedError") return
			assert.strictEqual(refused.error, "invalid_blocks")
			assert.deepStrictEqual(refused.details, [
				"[ERROR] must provide an object [json-pointer:/blocks/4/column_settings/0]",
			])
		}).pipe(
			Effect.provide(
				slackAnswering({
					ok: false,
					error: "invalid_blocks",
					response_metadata: {
						messages: [
							"[ERROR] must provide an object [json-pointer:/blocks/4/column_settings/0]",
						],
					},
				}),
			),
		),
	)
})
