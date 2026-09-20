/**
 * What a failed tool call does to a whole run, through the real engine and a scripted model.
 *
 * The handler tests pin each tool's `failureMode`; this pins what the engine does with it. A rejected
 * query must reach the model as a failed result it can rewrite, and a gated proposal must still end
 * the run.
 */
import { OrgId, UserId } from "@maple/domain"
import { Effect, Exit, Layer, Schema, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import type { Prompt, Response } from "effect/unstable/ai"
import * as AiModel from "effect/unstable/ai/Model"
import { assert, describe, it } from "vitest"
import { APP_ORIGIN } from "@maple/domain/chat-session"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import type { ResolvedModel } from "../platform/Llm"
import type { ChatTurnEvent } from "./events"
import { runChatTurn } from "./run"
import { makeRunUsage } from "./tools"

const TENANT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}

const USAGE = { inputTokens: { total: 1, uncached: 1 }, outputTokens: { total: 1, text: 1 } }

const callTool = (name: string, params: unknown): ReadonlyArray<Response.StreamPartEncoded> => [
	{ type: "tool-call", id: "call-1", name, params },
	{ type: "finish", reason: "tool-calls", usage: USAGE },
]

const answer = (text: string): ReadonlyArray<Response.StreamPartEncoded> => [
	{ type: "text-start", id: "text-1" },
	{ type: "text-delta", id: "text-1", delta: text },
	{ type: "text-end", id: "text-1" },
	{ type: "finish", reason: "stop", usage: USAGE },
]

/** A model that plays `script` one response per call, recording every prompt it was sent. */
const scriptedModel = (script: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>) => {
	const prompts: Array<Prompt.Prompt> = []
	const respond = (options: LanguageModel.ProviderOptions) => {
		prompts.push(options.prompt)
		return script[prompts.length - 1] ?? answer("(script ran out)")
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

const run = (model: ResolvedModel, executor: McpToolExecutorApi) => {
	const events: Array<ChatTurnEvent> = []
	const effect = runChatTurn({
		sessionId: "org_test:tab-1",
		messageId: "msg-1",
		tenant: TENANT,
		origin: APP_ORIGIN,
		toolExecutor: executor,
		model,
		submitDiagnosis: () => Effect.die("no investigation in a default session"),
		text: "how many services?",
		history: [],
		usage: makeRunUsage(),
		holdsTurn: () => true,
		append: (event) => events.push(event),
	})
	return { effect, events }
}

const rejectingExecutor: McpToolExecutorApi = {
	execute: () =>
		Effect.succeed({
			isError: true,
			content: [{ type: "text" as const, text: "SQL rejected (MissingOrgFilter)" }],
		}),
}

describe("runChatTurn tool failures", () => {
	it("hands a rejected query back to the model and finishes the run", async () => {
		const { model, prompts } = scriptedModel([
			callTool("run_sql", { sql: "select 1" }),
			answer("Rewrote it."),
		])
		const { effect, events } = run(model, rejectingExecutor)

		const exit = await Effect.runPromiseExit(effect)

		assert.isTrue(Exit.isSuccess(exit), `run failed: ${String(exit)}`)
		assert.lengthOf(prompts, 2, "the model is called again after the failed tool")
		const results = prompts[1]!.content.flatMap((message) =>
			message.role === "tool" ? message.content : [],
		)
		assert.deepInclude(
			results.map(
				(part) => part.type === "tool-result" && { name: part.name, isFailure: part.isFailure },
			),
			{ name: "run_sql", isFailure: true },
		)
		assert.deepInclude(
			events.map(
				(event) => event.type === "tool-result" && { output: event.output, isError: event.isError },
			),
			{ output: "SQL rejected (MissingOrgFilter)", isError: true },
		)
		assert.deepEqual(events.at(-1), { type: "turn-end", messageId: "msg-1", reason: "stop" })
	})

	it("still ends the run on a gated proposal", async () => {
		const { model, prompts } = scriptedModel([
			callTool("create_dashboard", { name: "Checkout" }),
			answer("should never be asked"),
		])
		const { effect } = run(model, rejectingExecutor)

		const exit = await Effect.runPromiseExit(effect)

		assert.isTrue(Exit.isFailure(exit))
		assert.lengthOf(prompts, 1, "a proposal is the turn's last word")
	})
})
