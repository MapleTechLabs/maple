/**
 * The close-out's view of a failed pass: the evidence it gathered, bounded so the close-out fits.
 */
import { ChatMessage, ChatToolCall } from "@maple/domain/chat-session"
import { assert, describe, it } from "vitest"
import { MAX_LIVE_CONTEXT_TOKENS } from "./budgets"
import { CLOSE_OUT_EVIDENCE_CHARS, withToolTranscript } from "./close-out"
import { String as Str } from "effect"

const pass = (calls: number, outputChars: number) =>
	new ChatMessage({
		id: "pass",
		role: "assistant",
		text: "",
		toolCalls: Array.from(
			{ length: calls },
			(_, i) =>
				new ChatToolCall({
					id: `c${i}`,
					name: "pr_file_diff",
					input: { paths: [`src/f${i}.ts`] },
					output: `${i}:${Str.repeat(outputChars)("x")}`,
				}),
		),
		createdAt: 0,
		startSeq: 1,
	})

describe("withToolTranscript", () => {
	it("renders a result's text without its UI payload", () => {
		const message = new ChatMessage({
			id: "pass",
			role: "assistant",
			text: "",
			toolCalls: [
				new ChatToolCall({
					id: "c0",
					name: "list_services",
					input: {},
					output: {
						text: "## Services",
						ui: { __maple_ui: true, tool: "list_services", data: {} },
					},
				}),
			],
			createdAt: 0,
			startSeq: 1,
		})
		const [rendered] = withToolTranscript([message])
		assert.isDefined(rendered)
		assert.include(rendered.text, "## Services")
		assert.notInclude(rendered.text, "__maple_ui")
	})

	it("renders every call of a small pass", () => {
		const [message] = withToolTranscript([pass(3, 100)])
		assert.isDefined(message)
		assert.include(message.text, "src/f0.ts")
		assert.include(message.text, "src/f2.ts")
		assert.notInclude(message.text, "left out for length")
	})

	/** A 149-call pass once rendered past the context limit, and the close-out died before its first call. */
	it("keeps a long pass under the budget, newest calls first, and counts what it left out", () => {
		const [message] = withToolTranscript([pass(149, 19_000)])
		assert.isDefined(message)
		const text = message.text
		assert.isAtMost(text.length, CLOSE_OUT_EVIDENCE_CHARS + 1_000)
		assert.include(text, "src/f148.ts")
		assert.notInclude(text, "src/f0.ts")
		assert.match(text, /\(\d+ earlier tool calls left out for length\.\)/)
	})

	/**
	 * An investigation close-out opened at 123k of its 128k limit with a 39k system prompt, and the
	 * round after its submission failed with `ContextBudgetError` (2026-11-16).
	 */
	it("leaves a close-out room for the round after it submits", () => {
		const SYSTEM_PROMPT_TOKENS = 39_282
		const CHARS_PER_TOKEN = 2.4
		const SUBMIT_ROUND_TOKENS = 20_000
		const [message] = withToolTranscript([pass(149, 19_000)])
		const evidenceTokens = (message?.text.length ?? Infinity) / CHARS_PER_TOKEN
		assert.isAtMost(SYSTEM_PROMPT_TOKENS + evidenceTokens + SUBMIT_ROUND_TOKENS, MAX_LIVE_CONTEXT_TOKENS)
	})
})
