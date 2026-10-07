import { afterEach, expect, it, vi } from "vitest"
import { Effect } from "effect"
import type { McpToolExecutorApi } from "../dispatcher"
import { runToolLoop } from "./utils"

/** One OpenRouter chat completion, in the shape the provider decodes. */
const completion = (message: Record<string, unknown>, finishReason: string): Response =>
	new Response(
		JSON.stringify({
			id: "gen-1",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "eval-model",
			system_fingerprint: null,
			choices: [
				{
					index: 0,
					message: { role: "assistant", ...message },
					finish_reason: finishReason,
					logprobs: null,
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}),
		{ headers: { "content-type": "application/json" } },
	)

const failingExecutor: McpToolExecutorApi = {
	execute: () =>
		Effect.succeed({ content: [{ type: "text", text: "Trace abc was not found." }], isError: true }),
	prepareRepository: () => Effect.void,
	prepareConnectedRepositories: () => Effect.void,
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

it("keeps a failed tool call's error in the transcript", async () => {
	vi.stubEnv("OPENROUTER_API_KEY", "sk-test")
	const replies = [
		completion(
			{
				content: null,
				tool_calls: [
					{
						id: "c1",
						type: "function",
						function: { name: "inspect_trace", arguments: '{"trace_id":"abc"}' },
					},
				],
			},
			"tool_calls",
		),
		completion({ content: "That trace does not exist." }, "stop"),
	]
	vi.stubGlobal("fetch", async () => replies.shift() ?? completion({ content: "" }, "stop"))

	const transcript = await Effect.runPromise(runToolLoop(failingExecutor, "inspect trace abc", 6))

	expect(transcript.toolCalls).toEqual([{ name: "inspect_trace", arguments: { trace_id: "abc" } }])
	expect(transcript.toolOutputs).toHaveLength(1)
	expect(transcript.toolOutputs[0]).toContain("Trace abc was not found.")
	expect(transcript.text).toBe("That trace does not exist.")
})
