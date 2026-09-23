/**
 * The two judgements a reader will want to argue with, as a table: how much of a conversation the
 * model is shown, and when a bot answers something that was not said to it.
 */
import type { ChatHistoryMessage, InboundMessage } from "@maple/chat-platform"
import { stripChatContext } from "@maple/domain/chat-preamble"
import { describe, expect, it } from "vitest"
import { chatTurnText, FOLLOW_UP_WINDOW_MS, isFollowUpTurn } from "./conversation.ts"

const NOW = Date.parse("2026-09-23T12:00:00.000Z")

const message: InboundMessage = {
	type: "message",
	connector: "testchat" as InboundMessage["connector"],
	workspaceId: "workspace-1",
	channelId: "channel-1",
	messageId: "message-9",
	author: { id: "author-1", displayName: "Ada", isBot: false },
	text: "why is checkout slow?",
	mentionsBot: true,
}

const said = (displayName: string, text: string, secondsAgo: number, isBot = false): ChatHistoryMessage => ({
	displayName,
	isBot,
	text,
	at: NOW - secondsAgo * 1000,
})

const context = (recent: ReadonlyArray<ChatHistoryMessage>, seenUpTo = 0) =>
	chatTurnText(message, { now: NOW, recent, seenUpTo })

describe("the context a turn carries", () => {
	it("says who is asking and when, and leaves the question itself outside the fence", () => {
		const text = context([])

		expect(text).toContain("Ada is asking")
		// The one thing nothing else in the prompt carries: a turn an hour into a thread must not
		// read the thread's first timestamp as "now".
		expect(text).toContain("The time is 2026-09-23T12:00:00Z.")
		expect(stripChatContext(text)).toBe("why is checkout slow?")
	})

	it("renders the conversation oldest first, marking what a bot said", () => {
		const text = context([said("Maple", "Checkout is slow.", 30, true), said("Bo", "anyone else?", 60)])

		const block = text.slice(text.indexOf("oldest first"))
		expect(block.indexOf("Bo: anyone else?")).toBeLessThan(block.indexOf("Maple (bot):"))
		expect(block).toContain("2026-09-23T11:59:30Z Maple (bot): Checkout is slow.")
	})

	it("leaves out what the session's own transcript already holds", () => {
		// The model reads that transcript in the same window. A message it sees twice is one it may
		// answer twice, and the exchange the bot has already had is the bulk of any thread.
		const seenUpTo = NOW - 45_000
		const text = context([said("Bo", "and now?", 30), said("Ada", "why is checkout slow?", 60)], seenUpTo)

		expect(text).toContain("Bo: and now?")
		expect(text).not.toContain("Bo: why is checkout slow?")
		expect(text.match(/why is checkout slow\?/gu)).toHaveLength(1)
	})

	it("says nothing about the conversation when nothing is left to say about it", () => {
		const text = context([said("Bo", "older", 600)], NOW - 60_000)
		expect(text).not.toContain("oldest first")
	})

	it("keeps the newest messages when there are more than it shows", () => {
		const many = Array.from({ length: 40 }, (_, index) => said("Bo", `line ${index}`, index + 1))
		const text = context(many)

		expect(text).toContain("line 0")
		expect(text).toContain("line 19")
		expect(text).not.toContain("line 20")
	})

	it("keeps the newest messages when they are longer than the budget allows", () => {
		const long = Array.from({ length: 20 }, (_, index) =>
			said("Bo", `${index}`.padEnd(400, "x"), index + 1),
		)
		const text = context(long)

		expect(text).toContain("\n2026-09-23T11:59:59Z Bo: 0xxx")
		expect(text.length).toBeLessThan(5000)
	})

	it("stops at the budget rather than skipping past one long message", () => {
		// The cut is a cut, not a filter: what is kept is a contiguous run back from the newest
		// message, so the model reads a conversation and not an edited one.
		const text = context([
			...Array.from({ length: 10 }, (_, index) => said("Bo", `${index}`.padEnd(400, "x"), index + 1)),
			said("Ada", "short enough to fit", 20),
		])

		expect(text).toContain("Bo: 0xxx")
		expect(text).not.toContain("Ada: short enough to fit")
	})

	it("drops a message the platform gave it no text for", () => {
		// Every message a deployment without the privileged content intent can read about but not
		// read: a blank line in the context says only that somebody spoke.
		const text = context([said("Bo", "", 30), said("Ada", "still slow", 60)])

		expect(text).toContain("Ada: still slow")
		expect(text).not.toContain("Bo:")
	})

	it("puts one message on one line, cut where it stops being context", () => {
		const text = context([said("Bo", `first\nsecond ${"y".repeat(600)}`, 30)])

		expect(text).toContain("Bo: first second yyy")
		expect(text).toContain("…")
		expect(text.split("\n").filter((line) => line.includes("Bo:"))).toHaveLength(1)
	})
})

describe("answering a message that mentioned nobody", () => {
	const unaddressed = { ...message, mentionsBot: false }
	const followUp = {
		message: unaddressed,
		ownsConversation: true,
		lastTurnAt: NOW - 60_000,
		now: NOW,
	}

	it("answers in a conversation the bot opened and spoke in recently", () => {
		expect(isFollowUpTurn(followUp)).toBe(true)
	})

	it("stays out of a conversation the bot did not open", () => {
		// A channel it was invited to, and a thread somebody else started and mentioned it in once.
		// Both stay mention-only however recently it spoke in them.
		expect(isFollowUpTurn({ ...followUp, ownsConversation: false })).toBe(false)
	})

	it("stays out of a conversation whose session has never held a turn", () => {
		expect(isFollowUpTurn({ ...followUp, lastTurnAt: 0 })).toBe(false)
	})

	it("stops answering once the conversation has gone quiet for a day", () => {
		expect(isFollowUpTurn({ ...followUp, lastTurnAt: NOW - FOLLOW_UP_WINDOW_MS })).toBe(true)
		expect(isFollowUpTurn({ ...followUp, lastTurnAt: NOW - FOLLOW_UP_WINDOW_MS - 1 })).toBe(false)
	})

	it("never answers another bot, which is how two of them talk until the budget runs out", () => {
		const bot = { ...unaddressed, author: { ...unaddressed.author, isBot: true } }
		expect(isFollowUpTurn({ ...followUp, message: bot })).toBe(false)
	})

	it("never answers a message with nothing in it", () => {
		expect(isFollowUpTurn({ ...followUp, message: { ...unaddressed, text: "  " } })).toBe(false)
	})
})
