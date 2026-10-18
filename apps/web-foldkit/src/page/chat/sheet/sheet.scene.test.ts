import { Result } from "effect"
import { describe, expect, test } from "vitest"
import * as Dialog from "../../../ui/dialog"
import { Message as ConversationMessage } from "../conversation/message"
import { init, Message, type Model } from "./model"
import { update } from "./update"

// The global chat sheet's update logic (`GlobalChatSheet` + `GlobalChatPanel`).

const NOW = Date.parse("2026-10-01T12:00:00Z")
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const step = (model: Model, message: Message) => update(model, message, "org_acme")

const opened = (viaKeyboard = false) => {
	const open = step(init(), Message.RequestedOpen({ viaKeyboard }))
	return step(open.model, Message.CompletedReadSheetTab({ orgId: "org_acme", tabId: "quick", nowMs: NOW, referrerPath: null }))
}

describe("chat sheet", () => {
	test("opening reads the thread it last showed, then that conversation's history", () => {
		const open = step(init(), Message.RequestedOpen({ viaKeyboard: false }))
		expect(open.model.dialog.isOpen).toBe(true)
		expect(names(open.commands)).toContain("ReadChatSheetTab")
		const read = opened()
		expect(read.model.conversation?.sessionId).toBe("org_acme:quick")
		expect(names(read.commands)).toEqual(["LoadChatHistory"])
	})

	test("without an org the sheet stays closed (`if (!orgId) return null`)", () => {
		expect(update(init(), Message.RequestedOpen({ viaKeyboard: true }), null).model.dialog.isOpen).toBe(false)
	})

	test("New chat creates a stored tab and moves the sheet onto it", () => {
		const model = opened().model
		expect(names(step(model, Message.ClickedNewChat()).commands)).toEqual(["CreateChatSheetTab"])
		const created = step(model, Message.CreatedSheetTab({ orgId: "org_acme", tabId: "t-new", referrerPath: null }))
		expect(created.model.tabId).toBe("t-new")
		expect(created.model.conversation?.sessionId).toBe("org_acme:t-new")
	})

	test("the first message names the stored tab", () => {
		const model = step(opened().model, Message.CreatedSheetTab({ orgId: "org_acme", tabId: "t-new", referrerPath: null })).model
		const historyRead = step(
			model,
			Message.GotConversationMessage({
				message: ConversationMessage.CompletedLoadHistory({ generation: 1, result: Result.succeed({ messages: [], cursor: 0, running: false }) }),
			}),
		).model
		const sent = step(historyRead, Message.GotConversationMessage({ message: ConversationMessage.ClickedSuggestion({ text: "Show me the slowest traces" }) }))
		const rename = sent.commands?.find((command) => command.name === "RenameChatSheetTab")
		expect(rename?.args).toEqual({ orgId: "org_acme", tabId: "t-new", title: "Show me the slowest traces" })
	})

	test("opened over a page, the first message carries its context until the chip is dismissed", () => {
		const overTraces = (dismiss: boolean) => {
			const open = step(init(), Message.RequestedOpen({ viaKeyboard: false })).model
			const read = step(open, Message.CompletedReadSheetTab({ orgId: "org_acme", tabId: "quick", nowMs: NOW, referrerPath: "/traces" })).model
			const kept = dismiss ? step(read, Message.DismissedContext({ id: "traces_explorer" })).model : read
			const loaded = step(
				kept,
				Message.GotConversationMessage({
					message: ConversationMessage.CompletedLoadHistory({ generation: 1, result: Result.succeed({ messages: [], cursor: 0, running: false }) }),
				}),
			).model
			const sent = step(loaded, Message.GotConversationMessage({ message: ConversationMessage.ClickedSuggestion({ text: "Why so slow?" }) }))
			const post = sent.commands?.find((command) => command.name === "PostChatMessage")
			return post?.args !== undefined && "text" in post.args ? String(post.args.text) : ""
		}
		expect(overTraces(false)).toContain("- view: traces explorer")
		expect(overTraces(true)).toBe("Why so slow?")
	})

	test("Open full page registers the thread in the tab list and closes the sheet", () => {
		const leaving = step(opened().model, Message.ClickedOpenFullPage())
		expect(names(leaving.commands)).toContain("EnsureChatSheetTab")
		expect(leaving.model.dialog.isOpen).toBe(false)
	})

	test("closing drops the conversation: it reloads when the sheet opens again", () => {
		const closed = step(opened().model, Message.GotDialogMessage({ message: Dialog.Message.ClickedClose() }))
		expect(closed.model.dialog.isOpen).toBe(false)
	})

	test("a header tooltip opens on keyboard focus, but not on the focus a pointer open lands", () => {
		const byPointer = step(opened(false).model, Message.FocusedVisibleTrigger({ triggerId: "chat-sheet-new-chat" }))
		expect(byPointer.model.tooltip.isOpen).toBe(false)
		const byKey = step(opened(true).model, Message.FocusedVisibleTrigger({ triggerId: "chat-sheet-new-chat" }))
		expect(byKey.model.tooltip.isOpen).toBe(true)
	})
})
