import { ChatEvent } from "@maple/domain/chat-session"
import { Effect, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { parseMarkdownTexts } from "../../kit/markdown"
import { TURN_IN_FLIGHT_MESSAGE } from "../kit/chat-api"
import { TextPart } from "../kit/ui-message"
import { Message, OutMessage } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

// The conversation's update logic (`useMapleChat`): history, sends, the live tail, stop, approvals.

const decodeEvent = Schema.decodeUnknownSync(ChatEvent)
const NO_CONTEXT = { preamble: "" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const step = (model: Model, message: Message) => update(model, message, NO_CONTEXT)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

/** History read, empty. */
const ready = (): Model =>
	step(
		init("default", "org_acme:default").model,
		Message.CompletedLoadHistory({
			generation: 1,
			result: Result.succeed({ messages: [], cursor: 0, running: false }),
		}),
	).model

const events = (generation: number, raw: ReadonlyArray<Record<string, unknown>>) =>
	Message.ReceivedChatEvents({ generation, events: raw.map((event) => decodeEvent(event)), nowMs: NOW })

describe("chat conversation", () => {
	test("entry reads the durable history; a stale answer is dropped", () => {
		const entered = init("default", "org_acme:default")
		expect(names(entered.commands)).toEqual(["LoadChatHistory"])
		const stale = step(
			entered.model,
			Message.CompletedLoadHistory({
				generation: 0,
				result: Result.succeed({ messages: [], cursor: 0, running: false }),
			}),
		)
		expect(stale.model.historyReady).toBe(false)
	})

	test("a turn still running when the history is read resumes its live tail from the cursor", () => {
		const resumed = step(
			init("default", "org_acme:default").model,
			Message.CompletedLoadHistory({
				generation: 1,
				result: Result.succeed({ messages: [], cursor: 12, running: true }),
			}),
		)
		expect(resumed.model.status).toBe("streaming")
		expect(resumed.model.stream).toEqual({ generation: 1, cursor: 12 })
	})

	test("submitting posts the composer's text, shows it at once and names the tab after it", () => {
		const typed = step(ready(), Message.ChangedDraft({ text: "  Why is checkout slow?  " })).model
		const sent = step(typed, Message.SubmittedComposer())
		expect(sent.model.draft).toBe("")
		expect(sent.model.status).toBe("submitted")
		expect(sent.model.messages.map((message) => message.role)).toEqual(["user"])
		expect(names(sent.commands)).toContain("PostChatMessage")
		expect(sent.outMessage).toEqual(OutMessage.SentFirstMessage({ title: "Why is checkout slow?" }))
	})

	test("each send is a chat_message_sent product event: the first turn, then follow-ups", () => {
		const first = step(ready(), Message.ClickedSuggestion({ text: "Health?" }))
		const turnOf = (result: typeof first) =>
			result.commands?.find(({ name }) => name === "TrackChatMessageSent")?.args
		expect(turnOf(first)).toEqual({ turn: "first" })
		const settled: Model = { ...first.model, status: "ready" }
		expect(turnOf(step(settled, Message.ClickedSuggestion({ text: "And now?" })))).toEqual({
			turn: "followup",
		})
	})

	test("the first message carries the page context fenced ahead of the user's words", () => {
		const sent = update(ready(), Message.ClickedSuggestion({ text: "What's wrong here?" }), {
			preamble: "## Current Page Context",
		})
		const post = sent.commands?.find(({ name }) => name === "PostChatMessage")
		expect(post?.args).toMatchObject({ raw: "What's wrong here?" })
		expect(JSON.stringify(post?.args)).toContain("<!--maple:context-->")
	})

	test("nothing is sent while a turn runs (the in-flight guard is in update)", () => {
		const sending = step(ready(), Message.ClickedSuggestion({ text: "One" })).model
		const again = step(sending, Message.ClickedSuggestion({ text: "Two" }))
		expect(again.commands ?? []).toEqual([])
		expect(again.model.messages).toHaveLength(1)
	})

	test("the accepted send opens the tail; its events stream the reply and the turn's end settles it", () => {
		const sending = step(ready(), Message.ClickedSuggestion({ text: "Health?" })).model
		const accepted = step(
			sending,
			Message.CompletedPostMessage({
				generation: sending.generation,
				localId: `local-${sending.generation}`,
				raw: "Health?",
				result: Result.succeed({ cursor: 0, messageId: "msg_user" }),
			}),
		).model
		expect(accepted.messages[0]?.id).toBe("msg_user")
		expect(accepted.stream).toEqual({ generation: sending.generation, cursor: 0 })
		const streamed = step(
			accepted,
			events(sending.generation, [
				{ type: "turn-start", seq: 1, messageId: "msg_reply" },
				{
					type: "tool-call",
					seq: 2,
					messageId: "msg_reply",
					callId: "c1",
					name: "list_services",
					input: {},
				},
				{
					type: "tool-result",
					seq: 3,
					messageId: "msg_reply",
					callId: "c1",
					output: { text: "3 services" },
				},
				{ type: "text-delta", seq: 4, messageId: "msg_reply", text: "All " },
				{ type: "text-delta", seq: 5, messageId: "msg_reply", text: "good." },
			]),
		).model
		expect(streamed.status).toBe("streaming")
		expect(streamed.messages[1]?.parts.map((part) => part._tag)).toEqual(["dynamic-tool", "text"])
		const ended = step(
			streamed,
			events(sending.generation, [
				{ type: "turn-end", seq: 6, messageId: "msg_reply", reason: "stop" },
			]),
		).model
		expect(ended.status).toBe("ready")
		expect(ended.stream).toBeNull()
		expect(ended.messages[1]?.parts[1]).toMatchObject({ _tag: "text", text: "All good.", state: "done" })
	})

	test("an event folded already (a reconnected tail replays from its cursor) is not folded twice", () => {
		const sending = step(ready(), Message.ClickedSuggestion({ text: "Hi" })).model
		const accepted = step(
			sending,
			Message.CompletedPostMessage({
				generation: sending.generation,
				localId: `local-${sending.generation}`,
				raw: "Hi",
				result: Result.succeed({ cursor: 0, messageId: "u" }),
			}),
		).model
		const delta = [{ type: "text-delta", seq: 1, messageId: "r", text: "Hello" }]
		const twice = step(
			step(accepted, events(sending.generation, delta)).model,
			events(sending.generation, delta),
		).model
		expect(twice.messages[1]?.parts[0]).toMatchObject({ text: "Hello" })
	})

	test("a refused send drops its bubble and offers to try the same words again", () => {
		const sending = step(ready(), Message.ClickedSuggestion({ text: "Hi" })).model
		const refused = step(
			sending,
			Message.CompletedPostMessage({
				generation: sending.generation,
				localId: `local-${sending.generation}`,
				raw: "Hi",
				result: Result.fail(TURN_IN_FLIGHT_MESSAGE),
			}),
		).model
		expect(refused.messages).toEqual([])
		expect(refused.failedSend).toEqual({ message: "Hi", error: TURN_IN_FLIGHT_MESSAGE })
		expect(refused.status).toBe("ready")
	})

	test("stop drops the tail, closes the streaming text and asks the session to abort", () => {
		const sending = step(ready(), Message.ClickedSuggestion({ text: "Hi" })).model
		const stopped = step(sending, Message.ClickedStop())
		expect(stopped.model.status).toBe("ready")
		expect(stopped.model.stream).toBeNull()
		expect(names(stopped.commands)).toEqual(["AbortChatTurn"])
		const late = step(
			stopped.model,
			events(sending.generation, [{ type: "text-delta", seq: 1, messageId: "r", text: "late" }]),
		)
		expect(late.model.messages).toHaveLength(1)
	})

	test("a send stopped before its POST answered still tails the turn, so the server's turn-end settles it", () => {
		const sending = step(ready(), Message.ClickedSuggestion({ text: "Hi" })).model
		const stopped = step(sending, Message.ClickedStop()).model
		const accepted = step(
			stopped,
			Message.CompletedPostMessage({
				generation: sending.generation,
				localId: `local-${sending.generation}`,
				raw: "Hi",
				result: Result.succeed({ cursor: 3, messageId: "u" }),
			}),
		).model
		expect(accepted.stream).toEqual({ generation: accepted.generation, cursor: 3 })
		expect(accepted.messages[0]?.id).toBe("u")
		const reply = step(
			accepted,
			events(accepted.generation, [
				{ type: "turn-start", seq: 4, messageId: "r" },
				{ type: "text-delta", seq: 5, messageId: "r", text: "Hello" },
			]),
		).model
		expect(reply.status).toBe("streaming")
		const ended = step(
			reply,
			events(accepted.generation, [{ type: "turn-end", seq: 6, messageId: "r", reason: "stop" }]),
		).model
		expect(ended.status).toBe("ready")
		expect(ended.messages[1]?.parts[0]).toMatchObject({ text: "Hello" })
	})

	test("a lost stream surfaces as the turn's error", () => {
		const sending = step(ready(), Message.ClickedSuggestion({ text: "Hi" })).model
		const accepted = step(
			sending,
			Message.CompletedPostMessage({
				generation: sending.generation,
				localId: `local-${sending.generation}`,
				raw: "Hi",
				result: Result.succeed({ cursor: 0, messageId: "u" }),
			}),
		).model
		const lost = step(
			accepted,
			Message.FailedChatStream({ generation: sending.generation, message: "Lost connection to chat." }),
		).model
		expect(lost.status).toBe("error")
		expect(lost.error).toBe("Lost connection to chat.")
	})

	test("approving a proposal applies it once and reports the outcome", () => {
		const deciding = step(
			ready(),
			Message.ClickedApprove({ toolCallId: "c4", tool: "update_alert_rule" }),
		)
		expect(names(deciding.commands)).toEqual(["DecideChatApproval"])
		expect(
			step(deciding.model, Message.ClickedApprove({ toolCallId: "c4", tool: "update_alert_rule" }))
				.commands ?? [],
		).toEqual([])
		const applied = step(
			deciding.model,
			Message.CompletedDecideApproval({
				toolCallId: "c4",
				tool: "update_alert_rule",
				decision: "approve",
				result: Result.succeed({ isError: false, content: "ok" }),
			}),
		)
		expect(applied.model.resolvedApprovals).toEqual({ c4: "applied" })
		expect(applied.outMessage).toEqual(
			OutMessage.RequestedToast({ type: "success", title: "Change applied" }),
		)
	})

	test("a send before the history is read keeps the draft, and the history still lands", () => {
		const entered = init("default", "org_acme:default").model
		const typed = step(entered, Message.ChangedDraft({ text: "Hi" })).model
		const early = step(typed, Message.SubmittedComposer())
		expect(early.commands ?? []).toEqual([])
		expect(early.outMessage).toBeUndefined()
		expect(early.model.draft).toBe("Hi")
		const earlier = {
			id: "m1",
			role: "user" as const,
			parts: [TextPart.make({ text: "Earlier", state: "done" })],
		}
		const history = Message.CompletedLoadHistory({
			generation: 1,
			result: Result.succeed({ messages: [earlier], cursor: 3, running: false }),
		})
		const loaded = step(early.model, history).model
		expect(loaded.messages.map((message) => message.id)).toEqual(["m1"])
		const sent = step(loaded, Message.SubmittedComposer())
		expect(sent.outMessage).toBeUndefined()
		expect(names(sent.commands)).toContain("PostChatMessage")
	})

	test("a failed history read is not an empty thread: nothing sends until a retry reads it", () => {
		const entered = init("default", "org_acme:default").model
		const failed = step(
			entered,
			Message.CompletedLoadHistory({ generation: 1, result: Result.fail("Service unavailable") }),
		).model
		expect(failed.historyError).toBe("Service unavailable")
		expect(failed.error).toBeNull()
		const early = step(failed, Message.ClickedSuggestion({ text: "Hi" }))
		expect(early.commands ?? []).toEqual([])
		expect(early.outMessage).toBeUndefined()
		const retried = step(failed, Message.ClickedRetryHistory())
		expect(retried.commands?.map((command) => command.args)).toEqual([
			{ sessionId: "org_acme:default", generation: 2 },
		])
		const earlier = {
			id: "m1",
			role: "user" as const,
			parts: [TextPart.make({ text: "Earlier", state: "done" })],
		}
		const loaded = step(
			retried.model,
			Message.CompletedLoadHistory({
				generation: 2,
				result: Result.succeed({ messages: [earlier], cursor: 3, running: false }),
			}),
		).model
		expect(loaded.historyError).toBeNull()
		const sent = step(loaded, Message.ClickedSuggestion({ text: "Hi" }))
		expect(sent.outMessage).toBeUndefined()
		expect(names(sent.commands)).toContain("PostChatMessage")
	})

	test("a streaming answer parses one version at a time, keeps the last parse on screen and only on-screen bodies", async () => {
		const sending = step(ready(), Message.ClickedSuggestion({ text: "Hi" })).model
		const accepted = step(
			sending,
			Message.CompletedPostMessage({
				generation: sending.generation,
				localId: `local-${sending.generation}`,
				raw: "Hi",
				result: Result.succeed({ cursor: 0, messageId: "u" }),
			}),
		).model
		const delta = (seq: number, text: string) =>
			events(sending.generation, [{ type: "text-delta", seq, messageId: "r", text }])
		const first = step(accepted, delta(1, "All "))
		expect(first.commands?.find((command) => command.name === "ParseChatMarkdown")?.args).toEqual({
			texts: ["All "],
		})
		const second = step(first.model, delta(2, "good"))
		expect(names(second.commands)).not.toContain("ParseChatMarkdown")
		const parsed = await Effect.runPromise(parseMarkdownTexts(["Hi", "All "]))
		const landed = step(second.model, Message.CompletedParseMarkdown({ parsed }))
		expect(landed.commands?.find((command) => command.name === "ParseChatMarkdown")?.args).toEqual({
			texts: ["All good"],
		})
		expect(Object.keys(landed.model.markdown).toSorted()).toEqual(["All good", "Hi"])
		expect(landed.model.markdown["All good"]).toEqual({ document: parsed[1]?.document, isStale: true })
	})
})
