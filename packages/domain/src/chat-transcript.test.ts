/**
 * The fold under a *live* tail — the part `ChatSession.test.ts` cannot reach, since it drives the
 * same fold through a complete, replayed log. What the fold itself does with an event (deltas,
 * tool calls, nested sub-agents, retraction) is asserted there, against real SQLite.
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
	it("grows the caller's own view of the transcript as the answer streams", () => {
		const transcript = makeChatTranscript()
		// Captured before any event lands: a reader holds this once and watches it fill.
		const view = transcript.messages

		transcript.add(event(1, { type: "user-message", id: "u1", text: "why is checkout slow?" }), 10)
		transcript.add(event(2, { type: "turn-start", messageId: "a1" }), 20)
		transcript.add(event(3, { type: "text-delta", messageId: "a1", text: "Check" }), 20)

		assert.lengthOf(view, 2)
		assert.equal(view[1]?.text, "Check")

		transcript.add(event(4, { type: "text-delta", messageId: "a1", text: "ing." }), 20)

		assert.lengthOf(view, 2)
		assert.equal(view[1]?.text, "Checking.")
		assert.equal(view[1]?.startSeq, 2)
	})

	it("ignores events a reconnect replays, and reports the cursor to resume from", () => {
		const transcript = makeChatTranscript()
		transcript.add(event(1, { type: "user-message", id: "u1", text: "hi" }), 10)
		transcript.add(event(2, { type: "turn-start", messageId: "a1" }), 10)
		transcript.add(event(3, { type: "text-delta", messageId: "a1", text: "once" }), 10)
		assert.equal(transcript.seq, 3)

		// `subscribe(cursor)` resends from the cursor, so a reader resuming from a stale one is
		// handed events it already folded. Re-applying them would double the text and duplicate
		// the user's message.
		transcript.add(event(1, { type: "user-message", id: "u1", text: "hi" }), 10)
		transcript.add(event(3, { type: "text-delta", messageId: "a1", text: "once" }), 10)

		assert.lengthOf(transcript.messages, 2)
		assert.equal(transcript.messages[1]?.text, "once")
		assert.equal(transcript.seq, 3)

		transcript.add(event(4, { type: "text-delta", messageId: "a1", text: " more" }), 10)
		assert.equal(transcript.messages[1]?.text, "once more")
		assert.equal(transcript.seq, 4)
	})

	it("keeps a proposal open over the gate's refusal an older log recorded as its result", () => {
		const transcript = makeChatTranscript()
		const refusal = "create_dashboard requires user approval and was not executed."
		transcript.add(event(1, { type: "turn-start", messageId: "a1" }), 10)
		transcript.add(
			event(2, {
				type: "tool-call",
				messageId: "a1",
				callId: "c1",
				name: "create_dashboard",
				input: {},
				proposed: true,
			}),
			10,
		)
		transcript.add(
			event(3, { type: "tool-result", messageId: "a1", callId: "c1", output: refusal, isError: true }),
			10,
		)
		assert.notProperty(transcript.messages[0]?.toolCalls[0], "output")

		transcript.add(
			event(4, {
				type: "tool-result",
				messageId: "a1",
				callId: "c1",
				output: "Declined by Ada.",
				isError: true,
			}),
			10,
		)
		assert.deepInclude(transcript.messages[0]?.toolCalls[0], {
			output: "Declined by Ada.",
			isError: true,
		})
	})
})
