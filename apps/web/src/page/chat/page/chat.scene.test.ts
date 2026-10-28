import { OrgId } from "@maple/domain"
import { ChatEvent } from "@maple/domain/chat-session"
import { Result, Schema } from "effect"
import {
	Command,
	click,
	expect as expectView,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { AppRoute } from "../../../route"
import * as Menu from "../../../ui/menu"
import { PageOutMessage, type PageContext } from "../../contract"
import { Message as ConversationMessage } from "../conversation/message"
import { LoadHistory } from "../conversation/command"
import { CopyShareLink, CreateTab, SaveTabs } from "./command"
import { Message } from "./message"
import { MountMessage, MountStopClickPropagation } from "./mounts"
import { view } from "./view"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { groupTabs } from "./view-sidebar"

// `/chat`'s update logic: tabs, the sidebar's rename / delete / share, and its conversations.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const route = (search: Record<string, string> = {}) => AppRoute.Chat({ search })

const step = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const tab = (id: string, title = "New chat", updatedAt = NOW) => ({
	id,
	title,
	createdAt: updatedAt,
	updatedAt,
})

const loaded = (tabs = [tab("default")], activeTabId = "default", search: Record<string, string> = {}) =>
	step(
		init(route(search), context).model,
		Message.CompletedLoadTabs({
			state: { tabs, activeTabId },
			nowMs: NOW,
			origin: "https://app.maple.dev",
			referrerPath: null,
		}),
	)

const pickFromMenu = (model: Model, tabId: string, value: string) => {
	const opened = step(
		model,
		Message.GotTabMenuMessage({ tabId, message: Menu.Message.ClickedTrigger() }),
	).model
	const item = { kind: "Item" as const, value }
	return step(
		opened,
		Message.GotTabMenuMessage({ tabId, message: Menu.Message.ClickedItem({ index: 0, item }) }),
	)
}

describe("chat page", () => {
	test("entry reads the stored tabs, then every tab's conversation reads its history", () => {
		expect(names(init(route(), context).commands)).toEqual(
			expect.arrayContaining(["LoadChatTabs", "LoadChatSignalPresence"]),
		)
		const entered = loaded([tab("default"), tab("t2")])
		expect(names(entered.commands).filter((name) => name === "LoadChatHistory")).toHaveLength(2)
		expect(Object.keys(entered.model.conversations)).toEqual(["default", "t2"])
		// `writeTabToUrl`: the active tab lands in `?tab=` without a new history entry.
		expect(entered.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/chat?tab=default", isReplace: true }),
		)
	})

	test("`?tab=` picks a known tab; back/forward to another tab activates it", () => {
		const entered = loaded([tab("default"), tab("t2")], "default", { tab: "t2" }).model
		expect(entered.tabs?.activeTabId).toBe("t2")
		const back = routeChanged(entered, route({ tab: "default" }), context)
		expect(back.model.tabs?.activeTabId).toBe("default")
		expect(names(back.commands)).toEqual(["SaveChatTabs"])
	})

	test("New chat creates a tab, starts its conversation and makes it active", () => {
		const model = loaded().model
		expect(names(step(model, Message.ClickedNewChat()).commands)).toEqual(["CreateChatTab"])
		const created = step(model, Message.CreatedTab({ id: "t-new", nowMs: NOW }))
		expect(created.model.tabs?.activeTabId).toBe("t-new")
		expect(names(created.commands)).toContain("LoadChatHistory")
	})

	test("the first message renames its tab to its first 40 characters", () => {
		const history = ConversationMessage.CompletedLoadHistory({
			generation: 1,
			result: Result.succeed({ messages: [], cursor: 0, running: false }),
		})
		const model = step(
			loaded().model,
			Message.GotConversationMessage({ tabId: "default", message: history }),
		).model
		const typed = step(
			model,
			Message.GotConversationMessage({
				tabId: "default",
				message: ConversationMessage.ClickedSuggestion({
					text: "Which services have the highest error rate this week?",
				}),
			}),
		)
		expect(names(typed.commands)).toContain("StampChatRename")
		const renamed = step(
			typed.model,
			Message.StampedRename({
				id: "default",
				title: "Which services have the highest error ra",
				nowMs: NOW + 1,
			}),
		)
		expect(renamed.model.tabs?.tabs[0]?.title).toBe("Which services have the highest error ra")
	})

	test("a second tab's turn starting reconnects the first tab's tail from what it already folded", () => {
		const running = (cursor: number) =>
			ConversationMessage.CompletedLoadHistory({
				generation: 1,
				result: Result.succeed({ messages: [], cursor, running: true }),
			})
		const first = step(
			loaded([tab("default"), tab("t2")]).model,
			Message.GotConversationMessage({ tabId: "default", message: running(5) }),
		).model
		const delta = Schema.decodeUnknownSync(ChatEvent)({
			type: "text-delta",
			seq: 9,
			messageId: "r",
			text: "Hello",
		})
		const folded = step(
			first,
			Message.GotConversationMessage({
				tabId: "default",
				message: ConversationMessage.ReceivedChatEvents({
					generation: 1,
					events: [delta],
					nowMs: NOW,
				}),
			}),
		).model
		expect(folded.conversations.default?.stream?.cursor).toBe(5)
		const both = step(folded, Message.GotConversationMessage({ tabId: "t2", message: running(2) })).model
		expect(both.conversations.default?.stream?.cursor).toBe(9)
		expect(both.conversations.t2?.stream?.cursor).toBe(2)
	})

	test("double-click renames: Enter applies a changed title, Escape and an unchanged one cancel", () => {
		const model = loaded().model
		const editing = step(model, Message.DoubleClickedTab({ id: "default" })).model
		expect(editing.renamingId).toBe("default")
		const unchanged = step(editing, Message.CommittedRename())
		expect(unchanged.model.renamingId).toBeNull()
		expect(unchanged.commands ?? []).toEqual([])
		const typed = step(editing, Message.ChangedRenameDraft({ text: "  Checkout  " })).model
		const committed = step(typed, Message.CommittedRename())
		expect(committed.commands?.[0]?.args).toEqual({ id: "default", title: "Checkout" })
		expect(step(typed, Message.CancelledRename()).model.renamingId).toBeNull()
	})

	test("the actions menu's Delete asks first; confirming removes the tab and activates its neighbour", () => {
		const model = loaded([tab("a"), tab("b")], "b").model
		const asked = pickFromMenu(model, "b", "delete").model
		expect(asked.confirmDeleteId).toBe("b")
		expect(asked.deleteDialog.isOpen).toBe(true)
		const deleted = step(asked, Message.ClickedConfirmDelete())
		expect(deleted.model.tabs).toEqual({ tabs: [tab("a")], activeTabId: "a" })
		expect(Object.keys(deleted.model.conversations)).toEqual(["a"])
	})

	test("the last conversation cannot be deleted", () => {
		const model = loaded().model
		expect(pickFromMenu(model, "default", "delete").model.confirmDeleteId).toBeNull()
	})

	test("Copy link copies the read-only share URL and confirms it", () => {
		const model = loaded([tab("default", "Checkout incident")]).model
		const copying = pickFromMenu(model, "default", "copy-link")
		expect(copying.commands?.some((command) => command.name === "CopyChatShareLink")).toBe(true)
		const copy = copying.commands?.find((command) => command.name === "CopyChatShareLink")
		expect(copy?.args).toEqual({
			url: "https://app.maple.dev/chat?shared=default&title=Checkout+incident",
		})
		const done = step(copying.model, Message.CompletedCopyShareLink({ ok: true }))
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Share link copied", description: "" }),
		)
	})

	test("a shared link shows that conversation read-only, outside the viewer's own tabs", () => {
		const shared = init(route({ shared: "t9", title: "Payments" }), context)
		expect(names(shared.commands)).toContain("LoadChatHistory")
		expect(shared.model.conversations.t9?.readOnly).toBe("shared")
		const loadedShared = step(
			shared.model,
			Message.CompletedLoadTabs({
				state: { tabs: [tab("default")], activeTabId: "default" },
				nowMs: NOW,
				origin: "",
				referrerPath: null,
			}),
		)
		expect(Object.keys(loadedShared.model.conversations)).toEqual(["t9"])
	})

	test("the empty state reads trace presence; New chat opens a second conversation beside the first", () => {
		const ready = step(
			loaded().model,
			Message.GotConversationMessage({
				tabId: "default",
				message: ConversationMessage.CompletedLoadHistory({
					generation: 1,
					result: Result.succeed({ messages: [], cursor: 0, running: false }),
				}),
			}),
		).model
		const absent = step(
			ready,
			Message.CompletedLoadPresence({
				result: Result.succeed({ traces: { status: "absent", lastSeenMs: null } }),
			}),
		).model
		scene(
			{ update: step, view: withViewInputs(view, { context })() },
			given(absent),
			Mount.resolve(MountStopClickPropagation, MountMessage.CompletedMountStopClick()),
			expectView(text("Maple AI answers from your telemetry. Send some first.")).toExist(),
			expectView(role("complementary", { name: "Chat conversations" })).toExist(),
			expectView(text("Maple AI")).toExist(),
			click(role("button", { name: /^New chat$/ })),
			Command.resolve(CreateTab, Message.CreatedTab({ id: "t-new", nowMs: NOW })),
			Command.resolve(SaveTabs, Message.CompletedSaveTabs()),
			// The command is the conversation's: its result is the conversation's Message, lifted by Scene.
			Command.resolve(
				LoadHistory,
				ConversationMessage.CompletedLoadHistory({
					generation: 1,
					result: Result.succeed({ messages: [], cursor: 0, running: false }),
				}),
			),
			Mount.resolve(MountStopClickPropagation, MountMessage.CompletedMountStopClick()),
			expectView(role("button", { name: "Actions for New chat" })).toExist(),
		)
	})

	test("conversations group by recency: today, yesterday, the previous week, older", () => {
		const day = 24 * 60 * 60 * 1000
		const groups = groupTabs(
			[tab("a", "A", NOW - 8 * day), tab("b", "B", NOW), tab("c", "C", NOW - day)],
			NOW,
		)
		expect(groups.map((group) => [group.label, group.tabs.map((entry) => entry.id)])).toEqual([
			["Today", ["b"]],
			["Yesterday", ["c"]],
			["Older", ["a"]],
		])
	})
})

describe("chat page below md", () => {
	test("the header's trigger asks the shell for its sidebar sheet", () => {
		expect(step(loaded().model, Message.ClickedSidebarTrigger()).outMessage).toEqual(
			PageOutMessage.RequestedSidebarToggle(),
		)
	})

	test("the title opens the conversation sheet; picking a conversation there closes it", () => {
		const model = loaded([tab("default"), tab("t2", "Checkout errors")]).model
		const opened = step(model, Message.ClickedSwitchConversation()).model
		expect(opened.conversationSheet.isOpen).toBe(true)
		const picked = step(opened, Message.ClickedTab({ id: "t2" })).model
		expect(picked.tabs?.activeTabId).toBe("t2")
		expect(picked.conversationSheet.isOpen).toBe(false)
	})

	test("share copies the active conversation's link", () => {
		const shared = step(loaded().model, Message.ClickedCopyActiveShareLink())
		expect(names(shared.commands)).toEqual([CopyShareLink.name])
	})
})
