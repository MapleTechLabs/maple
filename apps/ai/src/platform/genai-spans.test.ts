/**
 * The budgets on Gen-AI content attributes. Input messages replay the whole transcript on every step
 * and tool results run to 50k, so these paths run in production far more often than the happy one.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { makeRecordingTracer } from "@/testing/recording-tracer"
import { invokeAgentAttributes, messagesJson, toolCallJson, withToolCallContent } from "./genai-spans"

const TRUNCATION_MARKER = "…[truncated]"

const userText = (content: string) => ({ role: "user", parts: [{ type: "text" as const, content }] })

describe("messagesJson", () => {
	it("drops whole oldest messages to fit, and counts them", () => {
		const { json, dropped } = messagesJson(
			[userText("a".repeat(600)), userText("b".repeat(600)), userText("c")],
			1_000,
		)

		assert.strictEqual(dropped, 1)
		assert.deepStrictEqual(
			JSON.parse(json).map(
				(message: { readonly parts: ReadonlyArray<{ readonly content: string }> }) =>
					message.parts[0]?.content[0],
			),
			["b", "c"],
		)
	})

	it("truncates the payloads of a newest message that outweighs the budget, rather than dropping it", () => {
		const { json, dropped } = messagesJson(
			[
				{
					role: "tool",
					parts: [{ type: "tool_call_response", id: "t1", response: "x".repeat(5_000) }],
				},
			],
			1_000,
		)

		assert.strictEqual(dropped, 0)
		assert.isBelow(json.length, 1_000)
		assert.isTrue(String(JSON.parse(json)[0].parts[0].response).endsWith(TRUNCATION_MARKER))
	})

	it("splits a message's allowance across its parts, so parallel tool results share one", () => {
		const { json, dropped } = messagesJson(
			[
				{
					role: "tool",
					parts: Array.from({ length: 20 }, (_, index) => ({
						type: "tool_call_response" as const,
						id: `t${index}`,
						response: "x".repeat(5_000),
					})),
				},
			],
			20_000,
		)

		assert.strictEqual(dropped, 0)
		assert.isAtMost(json.length, 20_000)
	})

	it("replaces a payload JSON cannot encode instead of throwing", () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic

		const { json } = messagesJson(
			[
				{
					role: "assistant",
					parts: [{ type: "tool_call", id: "t1", name: "query_data", arguments: cyclic }],
				},
			],
			1_000,
		)

		assert.strictEqual(JSON.parse(json)[0].parts[0].arguments, "[object Object]")
	})
})

describe("toolCallJson", () => {
	it("wraps a string result, truncating the text before wrapping it", () => {
		const result = String(JSON.parse(toolCallJson("x".repeat(20_000))).result)

		assert.isTrue(result.startsWith("xxx"))
		assert.isTrue(result.endsWith(TRUNCATION_MARKER))
	})

	it("holds a string result to the budget once escaped", () => {
		// Maple's tool results are JSON and tables: quotes and newlines double in length when wrapped.
		const json = toolCallJson('{"row":"a"}\n'.repeat(2_000))

		assert.isAtMost(json.length, 8_000)
		assert.isTrue(String(JSON.parse(json).result).endsWith(TRUNCATION_MARKER))
	})

	it("holds an oversized object to the budget as a truncated prefix", () => {
		const json = toolCallJson({ rows: '"quoted"'.repeat(5_000) })

		assert.isAtMost(json.length, 8_000)
		assert.strictEqual(JSON.parse(json).truncated, true)
		assert.isAbove(JSON.parse(json).prefix.length, 4_000)
	})

	it("cuts an escape-heavy object by what its encoding costs, not to nothing", () => {
		const json = toolCallJson({ rows: '\\"'.repeat(6_000) })

		assert.isAtMost(json.length, 8_000)
		assert.isAbove(JSON.parse(json).prefix.length, 3_000)
	})

	it("holds an oversized array to the budget too", () => {
		const json = toolCallJson(Array.from({ length: 3_000 }, (_, index) => ({ index })))

		assert.isAtMost(json.length, 8_000)
		assert.strictEqual(JSON.parse(json).truncated, true)
	})
})

describe("invokeAgentAttributes", () => {
	it("drops schemas and shortens descriptions when the definitions outweigh their budget", () => {
		const attributes = invokeAgentAttributes({
			agentName: "lens",
			agentDescription: "",
			conversationId: "pass-1",
			providerName: "openrouter",
			model: "test-model",
			tools: Array.from({ length: 40 }, (_, index) =>
				Tool.make(`tool_${index}`, {
					description: "d".repeat(1_000),
					parameters: Schema.Struct({ query: Schema.String }),
				}),
			),
		})
		const definitions = JSON.parse(String(attributes["gen_ai.tool.definitions"]))

		assert.strictEqual(definitions.length, 40)
		assert.notProperty(definitions[0], "parameters")
		assert.strictEqual(definitions[0].description, `${"d".repeat(128)}${TRUNCATION_MARKER}`)
		assert.notProperty(attributes, "gen_ai.agent.description")
	})
})

describe("withToolCallContent", () => {
	it.effect("leaves the handler and its span alone when there is no tool span to describe", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()

			const result = yield* withToolCallContent(Effect.succeed("done"), {
				description: "a tool",
				params: {},
			}).pipe(Effect.withSpan("not_a_tool"), Effect.withTracer(tracer))

			assert.strictEqual(result, "done")
			assert.strictEqual(spans[0]?.attributes.size, 0)
		}),
	)
})
