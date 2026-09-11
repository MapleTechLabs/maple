/**
 * The budgets on Gen-AI content attributes. Input messages replay the whole transcript on every step
 * and tool results run to 50k, so these paths run in production far more often than the happy one.
 */
import { assert, describe, it } from "@effect/vitest"
import { messagesJson, toolCallJson } from "./genai-spans"

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

	it("holds an oversized object to the budget as a truncated prefix", () => {
		const json = toolCallJson({ rows: '"quoted"'.repeat(5_000) })

		assert.isAtMost(json.length, 8_000)
		assert.strictEqual(JSON.parse(json).truncated, true)
	})
})
