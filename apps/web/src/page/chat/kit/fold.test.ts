import {
	ChatMessage,
	ChatToolCall,
	decodeChatEventPayload,
	encodeChatEventPayload,
	type ChatEventInput,
} from "@maple/domain/chat-session"
import { assert, describe, it } from "vitest"
import { applyChatEvent, historyMessageToUIMessage } from "./fold"
import type { UIMessage } from "./ui-message"

// A turn that ends with calls in flight: Stop, a failure or the step limit. They never settle.

const events: ReadonlyArray<ChatEventInput> = [
	{ type: "turn-start", messageId: "a1" },
	{ type: "tool-call", messageId: "a1", callId: "c1", name: "run_sql", input: {} },
	{ type: "tool-call", messageId: "a1", callId: "c2", name: "create_dashboard", input: {}, proposed: true },
	{ type: "turn-end", messageId: "a1", reason: "aborted" },
]

const toolStates = (message: UIMessage | undefined) =>
	message?.parts.flatMap((part) => (part._tag === "dynamic-tool" ? [part.state] : []))

describe("a turn that ends with calls unsettled", () => {
	it("stops them in the live view, but keeps a proposal open", () => {
		const messages = events.reduce<ReadonlyArray<UIMessage>>(
			(folded, input, index) =>
				applyChatEvent(folded, decodeChatEventPayload(encodeChatEventPayload(input), index + 1), 10),
			[],
		)
		assert.deepStrictEqual(toolStates(messages[0]), ["output-stopped", "proposed"])
	})

	it("stops them after a reload", () => {
		const message = historyMessageToUIMessage(
			new ChatMessage({
				id: "a1",
				role: "assistant",
				text: "",
				toolCalls: [new ChatToolCall({ id: "c1", name: "run_sql", input: {}, stopped: true })],
				createdAt: 10,
				startSeq: 1,
			}),
		)
		assert.deepStrictEqual(toolStates(message), ["output-stopped"])
	})
})
