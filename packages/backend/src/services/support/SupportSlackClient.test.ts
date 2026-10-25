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
				slackAnswering({ ok: true, channel: "C123", ts: "1729600000.000100", message: { text: "hi" } }),
			),
		),
	)

	it.effect("reads a conversations.create answer, whose channel is an object", () =>
		Effect.gen(function* () {
			const slack = yield* SupportSlackClient
			const answer = yield* slack.call("conversations.create", { name: "maple-acme" })
			assert.deepStrictEqual(answer.channel, { id: "C9", name: "maple-acme" })
		}).pipe(
			Effect.provide(slackAnswering({ ok: true, channel: { id: "C9", name: "maple-acme", is_private: false } })),
		),
	)
})
