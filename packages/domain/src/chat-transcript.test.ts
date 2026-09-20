/**
 * The fold's behaviour under a *live* tail, which is what this module adds over the Durable
 * Object's cold replay — `ChatSession.test.ts` covers the replay against real SQLite.
 */
import { assert, describe, it } from "vitest"
import {
	decodeChatEventPayload,
	encodeChatEventPayload,
	type ChatEvent,
	type ChatEventInput,
} from "./chat-session"
import { makeChatTranscript } from "./chat-transcript"

/** Through the real codec, so the fold sees exactly what a stored or streamed event decodes to. */
const event = (seq: number, input: ChatEventInput): ChatEvent =>
	decodeChatEventPayload(encodeChatEventPayload(input), seq)

describe("makeChatTranscript", () => {
	it("exposes the answer as it streams, not only once the turn ends", () => {
		const transcript = makeChatTranscript()
		transcript.add(event(1, { type: "user-message", id: "u1", text: "why is checkout slow?" }), 10)
		transcript.add(event(2, { type: "turn-start", messageId: "a1" }), 20)
		transcript.add(event(3, { type: "text-delta", messageId: "a1", text: "Check" }), 20)

		assert.lengthOf(transcript.messages, 2)
		assert.equal(transcript.messages[1]?.text, "Check")

		transcript.add(event(4, { type: "text-delta", messageId: "a1", text: "ing." }), 20)

		// Same array, same message: a reader holding `messages` sees the turn grow.
		assert.lengthOf(transcript.messages, 2)
		assert.equal(transcript.messages[1]?.text, "Checking.")
		assert.equal(transcript.messages[1]?.startSeq, 2)
	})

	it("nests a sub-agent's turn under the call that started it", () => {
		const task = { id: "t1", agent: "explore", parentMessageId: "a1" }
		const transcript = makeChatTranscript()
		transcript.add(event(1, { type: "turn-start", messageId: "a1" }), 10)
		transcript.add(
			event(2, { type: "tool-call", messageId: "a1", callId: "t1", name: "task_explore", input: {} }),
			10,
		)
		transcript.add(event(3, { type: "turn-start", messageId: "c1", task }), 10)
		transcript.add(event(4, { type: "text-delta", messageId: "c1", text: "p99 is 4.2s", task }), 10)

		const call = transcript.messages[0]?.toolCalls[0]
		assert.equal(call?.task?.status, "running")
		assert.equal(call?.task?.messages[0]?.text, "p99 is 4.2s")
		assert.lengthOf(transcript.messages, 1)

		transcript.add(event(5, { type: "turn-end", messageId: "c1", reason: "stop", task }), 10)
		assert.equal(transcript.messages[0]?.toolCalls[0]?.task?.status, "completed")
	})

	it("drops a sub-agent event whose parent call it has not seen", () => {
		const transcript = makeChatTranscript()
		transcript.add(
			event(1, {
				type: "text-delta",
				messageId: "c1",
				text: "orphan",
				task: { id: "t1", agent: "explore", parentMessageId: "a1" },
			}),
			10,
		)

		assert.lengthOf(transcript.messages, 0)
	})
})
