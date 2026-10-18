import { makeChatSessionId } from "@maple/domain/chat-session"
import { deriveAutoContexts, suggestionsForContexts, type AutoContext } from "@maple/web/components/chat/auto-contexts"
import { Array, Option, Result } from "effect"
import { Command } from "foldkit"
import type { Resources } from "../../../platform/resources"
import type { AppRoute } from "../../../route"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { SignalPresenceData } from "../../kit/signal-presence"
import * as ConversationModel from "../conversation/model"
import { Message as ConversationMessage, OutMessage as ConversationOut } from "../conversation/message"
import * as Conversation from "../conversation/update"
import { pageContextPreamble } from "../kit/preamble"
import {
	CopyShareLink,
	CreateTab,
	FocusComposer,
	LoadKnownServices,
	LoadPresence,
	LoadTabs,
	SaveTabs,
	StampRename,
	shareUrl,
} from "./command"
import { Message } from "./message"
import { type ChatTab, DELETE_DIALOG_ID, type Model, type TabsState } from "./model"

export type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
type ChatRoute = Extract<AppRoute, { readonly _tag: "Chat" }>

export const DEFAULT_SUGGESTIONS = [
	"What's the overall system health?",
	"Show me the slowest traces",
	"Are there any errors right now?",
	"Which services have the highest error rate?",
]

export const composerId = (tabId: string): string => `chat-composer-${tabId}`

const withCommands = (result: Return, commands: Commands): Return => ({
	...result,
	commands: [...(result.commands ?? []), ...commands],
})

/** The referrer's contexts the user has not dismissed (`activeContexts`). */
export const activeContexts = (model: Model): ReadonlyArray<AutoContext> =>
	model.referrerPath === null
		? []
		: deriveAutoContexts(model.referrerPath).filter((context) => !model.dismissedContexts.includes(context.id))

export const suggestionsOf = (model: Model): ReadonlyArray<string> =>
	suggestionsForContexts([...activeContexts(model)]) ?? DEFAULT_SUGGESTIONS

const sendContext = (model: Model): Conversation.SendContext => ({
	preamble: pageContextPreamble(model.referrerPath, activeContexts(model)),
})

export const activeTabId = (model: Model): string | null => model.tabs?.activeTabId ?? null

// CONVERSATIONS

const liftConversation = (model: Model, tabId: string, step: Conversation.Return): Return => {
	const next: Model = { ...model, conversations: { ...model.conversations, [tabId]: step.model } }
	const commands = Command.mapMessages(step.commands ?? [], (message) => Message.GotConversationMessage({ tabId, message }))
	const lifted: Return = { model: next, commands }
	const withOut = Option.match(Option.fromNullishOr(step.outMessage), {
		onNone: () => lifted,
		onSome: (out) =>
			ConversationOut.match<Return>(out, {
				SentFirstMessage: ({ title }) => withCommands(lifted, [StampRename({ id: tabId, title })]),
				RequestedToast: ({ type, title }) => ({
					...lifted,
					outMessage: PageOutMessage.RequestedToast({ type, title, description: "" }),
				}),
			}),
	})
	return requestKnownServices(withOut)
}

/** `KnownServicesProvider` mounts with the first transcript that has messages. */
const requestKnownServices = (result: Return): Return => {
	const model = result.model
	if (model.isKnownServicesRequested) return result
	const hasMessages = Object.values(model.conversations).some((conversation) => conversation.messages.length > 0)
	return hasMessages
		? withCommands({ ...result, model: { ...model, isKnownServicesRequested: true } }, [LoadKnownServices()])
		: result
}

const startConversations = (model: Model, tabIds: ReadonlyArray<string>, context: PageContext, readOnly: ConversationModel.ReadOnly = null): Return =>
	tabIds.reduce<Return>(
		(acc, tabId) =>
			tabId in acc.model.conversations
				? acc
				: (() => {
						const step = Conversation.init(tabId, makeChatSessionId(context.orgId, tabId), readOnly)
						const lifted = liftConversation(acc.model, tabId, step)
						return { ...lifted, commands: [...(acc.commands ?? []), ...(lifted.commands ?? [])] }
					})(),
		{ model },
	)

// TABS

const saveTabs = (model: Model, tabs: TabsState, context: PageContext): Return => ({
	model: { ...model, tabs },
	commands: [SaveTabs({ orgId: context.orgId, state: tabs })],
})

/** `writeTabToUrl`: the active tab in `?tab=`, replacing the history entry. */
const tabUrl = (tabId: string): PageOutMessage =>
	PageOutMessage.RequestedNavigation({ url: `/chat?tab=${encodeURIComponent(tabId)}`, isReplace: true })

const setActive = (model: Model, id: string, context: PageContext): Return => {
	const tabs = model.tabs
	if (tabs === null || tabs.activeTabId === id || !tabs.tabs.some((tab) => tab.id === id)) return { model }
	return { ...saveTabs(model, { ...tabs, activeTabId: id }, context), outMessage: tabUrl(id) }
}

const renameTab = (model: Model, id: string, title: string, nowMs: number, context: PageContext): Return =>
	model.tabs === null
		? { model }
		: saveTabs(
				model,
				{ ...model.tabs, tabs: model.tabs.tabs.map((tab) => (tab.id === id ? { ...tab, title, updatedAt: nowMs } : tab)) },
				context,
			)

/** `closeTab`: never the last one; closing the active tab activates its neighbour. */
const closeTab = (model: Model, id: string, context: PageContext): Return => {
	const tabs = model.tabs
	if (tabs === null || tabs.tabs.length <= 1) return { model }
	const index = tabs.tabs.findIndex((tab) => tab.id === id)
	if (index === -1) return { model }
	const remaining = tabs.tabs.filter((tab) => tab.id !== id)
	const activeTabId =
		tabs.activeTabId === id ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? tabs.activeTabId) : tabs.activeTabId
	const { [id]: _closed, ...conversations } = model.conversations
	const result = saveTabs({ ...model, conversations }, { tabs: remaining, activeTabId }, context)
	return activeTabId === tabs.activeTabId ? result : { ...result, outMessage: tabUrl(activeTabId) }
}

const tabById = (model: Model, id: string): Option.Option<ChatTab> =>
	Option.flatMap(Option.fromNullishOr(model.tabs), (tabs) => Array.findFirst(tabs.tabs, (tab) => tab.id === id))

const updateMenu = (model: Model, tabId: string, message: Menu.Message): Return => {
	const result = Menu.update(model.menus[tabId] ?? Menu.init(`chat-tab-menu-${tabId}`), message)
	const next: Model = { ...model, menus: { ...model.menus, [tabId]: result.model } }
	const commands = Command.mapMessages(result.commands ?? [], (child) => Message.GotTabMenuMessage({ tabId, message: child }))
	const picked = result.outMessage?._tag === "SelectedItem" ? result.outMessage.value : null
	const after = ((): Return => {
		switch (picked) {
			case "rename":
				return { model: { ...next, renamingId: tabId, renameDraft: Option.match(tabById(next, tabId), { onNone: () => "", onSome: (tab) => tab.title }) } }
			case "copy-link":
				return Option.match(tabById(next, tabId), {
					onNone: () => ({ model: next }),
					onSome: (tab) => ({ model: next, commands: [CopyShareLink({ url: shareUrl(next.origin, tab) })] }),
				})
			case "delete":
				return (next.tabs?.tabs.length ?? 0) > 1 ? updateDeleteDialog({ ...next, confirmDeleteId: tabId }, Dialog.open(next.deleteDialog)) : { model: next }
			default:
				return { model: next }
		}
	})()
	return { ...after, commands: [...commands, ...(after.commands ?? [])] }
}

const updateDeleteDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		deleteDialog: step.model,
		confirmDeleteId: step.outMessage?._tag === "Closed" ? null : model.confirmDeleteId,
	},
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDeleteDialogMessage({ message })),
})

// INIT

const sharedOf = (route: ChatRoute) =>
	route.search.shared === undefined || route.search.shared === ""
		? null
		: { tabId: route.search.shared, title: route.search.title ?? null, focusMessageId: route.search.m ?? null }

export const init = (route: ChatRoute, context: PageContext): Return => {
	const shared = sharedOf(route)
	const model: Model = {
		tabs: null,
		urlTabId: route.search.tab ?? null,
		shared,
		nowMs: 0,
		origin: "",
		conversations: {},
		renamingId: null,
		renameDraft: "",
		menus: {},
		deleteDialog: Dialog.init(DELETE_DIALOG_ID, "alert-dialog"),
		confirmDeleteId: null,
		referrerPath: null,
		dismissedContexts: [],
		presence: SignalPresenceData.Idle(),
		isPresenceRequested: false,
		knownServices: [],
		isKnownServicesRequested: false,
	}
	const loaded = withCommands({ model }, [LoadTabs({ orgId: context.orgId })])
	return shared === null ? loaded : withCommands(startConversations(model, [shared.tabId], context, "shared"), loaded.commands ?? [])
}

/** Back/forward lands a new `?tab=`; a changed `?shared=` is a different view. */
export const routeChanged = (model: Model, route: ChatRoute, context: PageContext): Return => {
	const shared = sharedOf(route)
	if (shared?.tabId !== model.shared?.tabId) return init(route, context)
	const tab = route.search.tab
	return tab === undefined ? { model } : setActive(model, tab, context)
}

// UPDATE

const createTab = (model: Model, id: string, nowMs: number, context: PageContext): Return => {
	if (model.tabs === null) return { model }
	const tab: ChatTab = { id, title: "New Chat", createdAt: nowMs, updatedAt: nowMs }
	const saved = saveTabs(model, { tabs: [...model.tabs.tabs, tab], activeTabId: id }, context)
	const started = startConversations(saved.model, [id], context)
	return { ...started, commands: [...(saved.commands ?? []), ...(started.commands ?? [])], outMessage: tabUrl(id) }
}

const commitRename = (model: Model): Return => {
	const id = model.renamingId
	if (id === null) return { model }
	const trimmed = model.renameDraft.trim()
	const cleared: Model = { ...model, renamingId: null }
	return Option.match(tabById(model, id), {
		onNone: () => ({ model: cleared }),
		onSome: (tab) =>
			trimmed !== "" && trimmed !== tab.title
				? { model: cleared, commands: [StampRename({ id, title: trimmed })] }
				: { model: cleared },
	})
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedLoadTabs: ({ state, nowMs, origin, referrerPath }) => {
			const urlTab = model.urlTabId
			const tabs =
				urlTab !== null && state.tabs.some((tab) => tab.id === urlTab) ? { ...state, activeTabId: urlTab } : state
			const loaded: Model = { ...model, tabs, nowMs, origin, referrerPath }
			if (model.shared !== null) return { model: loaded }
			const started = startConversations(loaded, tabs.tabs.map((tab) => tab.id), context)
			return urlTab === tabs.activeTabId ? started : { ...started, outMessage: tabUrl(tabs.activeTabId) }
		},
		ClickedNewChat: () => ({ model, commands: [CreateTab()] }),
		PressedNewChatKey: () => (model.shared === null ? { model, commands: [CreateTab()] } : { model }),
		CreatedTab: ({ id, nowMs }) => createTab(model, id, nowMs, context),
		ClickedTab: ({ id }) => (model.renamingId === id ? { model } : setActive(model, id, context)),
		DoubleClickedTab: ({ id }) =>
			model.renamingId === id
				? { model }
				: {
						model: {
							...model,
							renamingId: id,
							renameDraft: Option.match(tabById(model, id), { onNone: () => "", onSome: (tab) => tab.title }),
						},
					},
		ChangedRenameDraft: ({ text }) => ({ model: { ...model, renameDraft: text } }),
		CommittedRename: () => commitRename(model),
		CancelledRename: () => ({ model: { ...model, renamingId: null } }),
		StampedRename: ({ id, title, nowMs }) => renameTab(model, id, title, nowMs, context),
		GotTabMenuMessage: ({ tabId, message: child }) => updateMenu(model, tabId, child),
		GotDeleteDialogMessage: ({ message: child }) => updateDeleteDialog(model, Dialog.update(model.deleteDialog, child)),
		ClickedConfirmDelete: () => {
			const id = model.confirmDeleteId
			if (id === null) return { model }
			const closed = updateDeleteDialog({ ...model, confirmDeleteId: null }, Dialog.close(model.deleteDialog))
			const removed = closeTab(closed.model, id, context)
			return { ...removed, commands: [...(closed.commands ?? []), ...(removed.commands ?? [])] }
		},
		CompletedSaveTabs: () => ({ model }),
		CompletedCopyShareLink: ({ ok }) => ({
			model,
			outMessage: PageOutMessage.RequestedToast(
				ok
					? { type: "success", title: "Share link copied", description: "" }
					: { type: "error", title: "Failed to copy share link", description: "" },
			),
		}),
		GotConversationMessage: ({ tabId, message: child }) => {
			const conversation = model.conversations[tabId]
			return conversation === undefined
				? { model }
				: liftConversation(model, tabId, Conversation.update(conversation, child, sendContext(model)))
		},
		DismissedContext: ({ id }) =>
			model.dismissedContexts.includes(id) ? { model } : { model: { ...model, dismissedContexts: [...model.dismissedContexts, id] } },
		PaintedEmptyState: () =>
			model.isPresenceRequested
				? { model }
				: { model: { ...model, isPresenceRequested: true, presence: SignalPresenceData.Loading() }, commands: [LoadPresence()] },
		CompletedLoadPresence: ({ result }) => ({
			model: {
				...model,
				presence: Result.match(result, {
					onSuccess: (data) => SignalPresenceData.Success({ data }),
					onFailure: (error) => SignalPresenceData.Failure({ error }),
				}),
			},
		}),
		CompletedLoadKnownServices: ({ services }) => ({ model: { ...model, knownServices: services } }),
		TypedAnywhere: ({ char }) => {
			const id = activeTabId(model)
			const conversation = id === null ? undefined : model.conversations[id]
			if (id === null || conversation === undefined || conversation.readOnly !== null) return { model }
			const step = Conversation.update(conversation, ConversationMessage.ChangedDraft({ text: conversation.draft + char }), sendContext(model))
			return withCommands(liftConversation(model, id, step), [FocusComposer({ id: composerId(id) })])
		},
		CompletedFocusComposer: () => ({ model }),
		CompletedMountScroller: () => ({ model }),
		CompletedMountStopClick: () => ({ model }),
		CompletedMountRenameInput: () => ({ model }),
	})

