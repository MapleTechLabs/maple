/**
 * The turn's own message, as the model is actually sent it.
 *
 * The engine renders an agent's input through `inputPrompt`, and its default — for an agent that
 * declares none — is `JSON.stringify` of the encoded input. For a `Schema.String` input that turns
 * every user turn into a quoted, escape-sequenced literal: the model reads `\n` as two characters,
 * and Agent Sessions replays the turn to the engineer in the same form, which is how an
 * investigation's opening prompt came to render as an escaped blob.
 */
import { OrgId, UserId } from "@maple/domain"
import { Effect, Layer, Schema, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import type { Prompt, Response } from "effect/unstable/ai"
import * as AiModel from "effect/unstable/ai/Model"
import { assert, describe, it } from "vitest"
import { APP_ORIGIN } from "@maple/domain/chat-session"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import type { ResolvedModel } from "../platform/Llm"
import { runChatTurn } from "./run"
import { makeRunUsage } from "./tools"

const TENANT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}

const ANSWER: ReadonlyArray<Response.StreamPartEncoded> = [
	{ type: "text-start", id: "text-1" },
	{ type: "text-delta", id: "text-1", delta: "Looking." },
	{ type: "text-end", id: "text-1" },
	{
		type: "finish",
		reason: "stop",
		usage: { inputTokens: { total: 1, uncached: 1 }, outputTokens: { total: 1, text: 1 } },
	},
]

/** A model that answers once, recording the prompt it was sent. */
const recordingModel = () => {
	const prompts: Array<Prompt.Prompt> = []
	const respond = (options: LanguageModel.ProviderOptions) => {
		prompts.push(options.prompt)
		return ANSWER
	}
	const model: ResolvedModel = {
		provider: "openrouter",
		name: "scripted",
		limits: { context: 100_000, output: 4_000 },
		layer: AiModel.make(
			"openrouter",
			"scripted",
			Layer.effect(
				LanguageModel.LanguageModel,
				LanguageModel.make({
					generateText: (options) => Effect.succeed([...respond(options)]),
					streamText: (options) => Stream.suspend(() => Stream.fromIterable(respond(options))),
				}),
			),
		),
	}
	return { model, prompts }
}

const noTools: McpToolExecutorApi = { execute: () => Effect.die("no tool call expected") }

const userText = (prompt: Prompt.Prompt): string =>
	prompt.content
		.filter((message) => message.role === "user")
		.flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
		.join("")

describe("runChatTurn input", () => {
	it("sends the turn's message verbatim, not as a JSON string literal", async () => {
		const text =
			'<!--maple:context-->\nBegin the investigation. Subject: "checkout" is down.\n<!--/maple:context-->'
		const { model, prompts } = recordingModel()

		await Effect.runPromise(
			runChatTurn({
				sessionId: "org_test:tab-1",
				messageId: "msg-1",
				tenant: TENANT,
				origin: APP_ORIGIN,
				toolExecutor: noTools,
				model,
				submitDiagnosis: () => Effect.die("no investigation in a default session"),
				text,
				history: [],
				usage: makeRunUsage(),
				holdsTurn: () => true,
				append: () => {},
			}),
		)

		assert.lengthOf(prompts, 1)
		assert.equal(userText(prompts[0]!), text)
	})
})
