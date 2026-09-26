/**
 * The close-out's view of a failed pass: the evidence it gathered, bounded so the close-out fits.
 */
import { ChatMessage, ChatToolCall } from "@maple/domain/chat-session"
import { assert, describe, it } from "vitest"
import { CLOSE_OUT_EVIDENCE_CHARS, withToolTranscript } from "./close-out"

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
					output: `${i}:${"x".repeat(outputChars)}`,
				}),
		),
		createdAt: 0,
		startSeq: 1,
	})

describe("withToolTranscript", () => {
	it("renders every call of a small pass", () => {
		const [message] = withToolTranscript([pass(3, 100)])
		assert.include(message!.text, "src/f0.ts")
		assert.include(message!.text, "src/f2.ts")
		assert.notInclude(message!.text, "left out for length")
	})

	/** A 149-call pass once rendered past the context limit, and the close-out died before its first call. */
	it("keeps a long pass under the budget, newest calls first, and counts what it left out", () => {
		const [message] = withToolTranscript([pass(149, 19_000)])
		const text = message!.text
		assert.isAtMost(text.length, CLOSE_OUT_EVIDENCE_CHARS + 1_000)
		assert.include(text, "src/f148.ts")
		assert.notInclude(text, "src/f0.ts")
		assert.match(text, /\(\d+ earlier tool calls left out for length\.\)/)
	})
})
