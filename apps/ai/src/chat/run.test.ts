/**
 * `promptFromHistory` — what a new run actually replays to the model.
 *
 * This is where a long conversation either keeps its beginning or loses it. Dropping the head is
 * all it does: summarizing across turns was half-built here once, behind a durable event nothing
 * ever wrote, and is gone.
 */
import type { ChatMessage } from "@maple/domain/chat-session"
import { assert, describe, it } from "vitest"
import { promptFromHistory } from "./run"

let seq = 0

const message = (role: "user" | "assistant", text: string, toolCalls: unknown[] = []): ChatMessage =>
	({
		id: `m${(seq += 1)}`,
		role,
		text,
		toolCalls,
		createdAt: seq,
		startSeq: seq,
	}) as ChatMessage

const textOf = (messages: ReadonlyArray<{ content: ReadonlyArray<unknown> }>) =>
	messages.map((m) => m.content.map((part) => (part as { text?: string }).text ?? "").join(""))

describe("promptFromHistory", () => {
	it("replays the conversation in order", () => {
		seq = 0
		const replayed = promptFromHistory([
			message("user", "why is checkout slow?"),
			message("assistant", "Looking."),
			message("user", "and payments?"),
		])

		assert.deepEqual(textOf(replayed), ["why is checkout slow?", "Looking.", "and payments?"])
		assert.deepEqual(
			replayed.map((m) => m.role),
			["user", "assistant", "user"],
		)
	})

	it("drops messages with no text, so a pure tool turn is not replayed as an empty one", () => {
		seq = 0
		const replayed = promptFromHistory([
			message("user", "check it"),
			message("assistant", "", [{ id: "c1" }]),
			message("assistant", "Done."),
		])

		assert.deepEqual(textOf(replayed), ["check it", "Done."])
	})

	it("drops from the head when the transcript exceeds the message cap", () => {
		seq = 0
		const history = Array.from({ length: 50 }, (_, i) => message("user", `turn ${i}`))
		const replayed = promptFromHistory(history)

		assert.lengthOf(replayed, 40)
		// The tail is what the next turn needs; the head is what a human skimming would skip.
		assert.equal(textOf(replayed)[39], "turn 49")
	})

	it("keeps one message even when it alone blows the character budget", () => {
		// The `kept.length > 0` guard: otherwise a single pasted stack trace replays as *nothing*,
		// and the model answers the next question with no context at all.
		seq = 0
		const replayed = promptFromHistory([message("user", "x".repeat(80_000))])

		assert.lengthOf(replayed, 1)
	})
})
