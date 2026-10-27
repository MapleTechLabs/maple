import { makeChatSessionId } from "@maple/domain/chat-session"
import { suggestionsForContexts, type AutoContext } from "../../../components/chat/auto-contexts"
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
import { investigationSuggestions } from "../../investigations/detail/investigation-context"
import {
	activeContextsOf,
	investigationPreamble,
	pageContextPreamble,
	widgetFixPreamble,
} from "../kit/preamble"
import {
	type ChatSubject,
	subjectOfSearch,
	subjectTabId,
	subjectTabTitle,
	WIDGET_FIX_AUTO_PROMPT,
	WIDGET_FIX_SUGGESTIONS,
} from "../kit/subject"
import {
	CopyShareLink,
	CreateTab,
	StampSubjectTab,
	TypeIntoComposer,
	LoadKnownServices,
	LoadPresence,
	LoadTabs,
	SaveTabs,
	StampRename,
	shareUrl,
} from "./command"
import { Message } from "./message"
import { type ChatTab, CONVERSATION_SHEET_ID, DELETE_DIALOG_ID, type Model, type TabsState } from "./model"

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
	activeContextsOf(model.referrerPath, model.dismissedContexts)

/** The subject when `tabId` is its tab (`isInvestigationTab` / `isWidgetFixTab`). */
export const subjectFor = (model: Model, tabId: string): ChatSubject | null =>
	model.subject !== null && model.shared === null && subjectTabId(model.subject) === tabId
		? model.subject
		: null

export const suggestionsOf = (model: Model, tabId: string): ReadonlyArray<string> => {
	const subject = subjectFor(model, tabId)
	if (subject === null) return suggestionsForContexts([...activeContexts(model)]) ?? DEFAULT_SUGGESTIONS
	return subject._tag === "Investigation"
		? investigationSuggestions(subject.context)
		: WIDGET_FIX_SUGGESTIONS
}

/** `buildContextPreamble`: an explicit subject supersedes the page context. */
const sendContext = (model: Model, tabId: string): Conversation.SendContext => {
	const subject = subjectFor(model, tabId)
	return {
		preamble:
			subject === null
				? pageContextPreamble(model.referrerPath, activeContexts(model))
				: subject._tag === "Investigation"
					? investigationPreamble(subject.context)
					: widgetFixPreamble(subject.context),
	}
}

export const activeTabId = (model: Model): string | null => model.tabs?.activeTabId ?? null

// CONVERSATIONS

const liftConversation = (model: Model, tabId: string, step: Conversation.Return): Return => {
	const next: Model = { ...model, conversations: { ...model.conversations, [tabId]: step.model } }
	const commands = Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotConversationMessage({ tabId, message }),
	)
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
	const hasMessages = Object.values(model.conversations).some(
		(conversation) => conversation.messages.length > 0,
	)
	return hasMessages
		? withCommands({ ...result, model: { ...model, isKnownServicesRequested: true } }, [
				LoadKnownServices(),
			])
		: result
}

const startConversations = (
	model: Model,
	tabIds: ReadonlyArray<string>,
	context: PageContext,
	readOnly: ConversationModel.ReadOnly = null,
): Return =>
	tabIds.reduce<Return>(
		(acc, tabId) =>
			tabId in acc.model.conversations
				? acc
				: (() => {
						const step = Conversation.init(
							tabId,
							makeChatSessionId(context.orgId, tabId),
							readOnly,
						)
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

const KEPT_SEARCH = ["mode", "alert", "widget", "shared", "title", "m"] as const

/** `writeTabToUrl`: the active tab in `?tab=`, the other params kept, replacing the history entry. */
const tabUrl = (model: Model, tabId: string): PageOutMessage => {
	const kept = KEPT_SEARCH.flatMap((key) => {
		const value = model.search[key]
		return value === undefined ? [] : [[key, value]]
	})
	const params = new URLSearchParams([...kept, ["tab", tabId]])
	return PageOutMessage.RequestedNavigation({ url: `/chat?${params.toString()}`, isReplace: true })
}

const setActive = (model: Model, id: string, context: PageContext): Return => {
	const tabs = model.tabs
	if (tabs === null || tabs.activeTabId === id || !tabs.tabs.some((tab) => tab.id === id)) return { model }
	return { ...saveTabs(model, { ...tabs, activeTabId: id }, context), outMessage: tabUrl(model, id) }
}

/** `ensureTab(subjectTabId, subjectTabTitle)`: registered if new, activated, stamped. */
const ensureSubjectTab = (model: Model, nowMs: number, context: PageContext): Return => {
	const { tabs, subject } = model
	if (tabs === null || subject === null || model.shared !== null) return { model }
	const id = subjectTabId(subject)
	const exists = tabs.tabs.some((tab) => tab.id === id)
	if (exists && tabs.activeTabId === id) return { model }
	const next: TabsState = exists
		? {
				activeTabId: id,
				tabs: tabs.tabs.map((tab) => (tab.id === id ? { ...tab, updatedAt: nowMs } : tab)),
			}
		: {
				activeTabId: id,
				tabs: [
					...tabs.tabs,
					{ id, title: subjectTabTitle(subject), createdAt: nowMs, updatedAt: nowMs },
				],
			}
	return saveTabs(model, next, context)
}

const renameTab = (model: Model, id: string, title: string, nowMs: number, context: PageContext): Return =>
	model.tabs === null
		? { model }
		: saveTabs(
				model,
				{
					...model.tabs,
					tabs: model.tabs.tabs.map((tab) =>
						tab.id === id ? { ...tab, title, updatedAt: nowMs } : tab,
					),
				},
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
		tabs.activeTabId === id
			? (remaining[Math.min(index, remaining.length - 1)]?.id ?? tabs.activeTabId)
			: tabs.activeTabId
	const { [id]: _closed, ...conversations } = model.conversations
	const result = saveTabs({ ...model, conversations }, { tabs: remaining, activeTabId }, context)
	return activeTabId === tabs.activeTabId ? result : { ...result, outMessage: tabUrl(model, activeTabId) }
}

const tabById = (model: Model, id: string): Option.Option<ChatTab> =>
	Option.flatMap(Option.fromNullishOr(model.tabs), (tabs) =>
		Array.findFirst(tabs.tabs, (tab) => tab.id === id),
	)

const updateMenu = (model: Model, tabId: string, message: Menu.Message): Return => {
	const result = Menu.update(model.menus[tabId] ?? Menu.init(`chat-tab-menu-${tabId}`), message)
	const next: Model = { ...model, menus: { ...model.menus, [tabId]: result.model } }
	const commands = Command.mapMessages(result.commands ?? [], (child) =>
		Message.GotTabMenuMessage({ tabId, message: child }),
	)
	const picked = result.outMessage?._tag === "SelectedItem" ? result.outMessage.value : null
	const after = ((): Return => {
		switch (picked) {
			// The row swaps its trigger for the input, so the menu closes outright: a focus return
			// pending on its exit would land on the trigger rendered after the rename.
			case "rename":
				return {
					model: {
						...next,
						menus: { ...next.menus, [tabId]: Menu.init(`chat-tab-menu-${tabId}`) },
						renamingId: tabId,
						renameDraft: Option.match(tabById(next, tabId), {
							onNone: () => "",
							onSome: (tab) => tab.title,
						}),
					},
				}
			case "copy-link":
				return Option.match(tabById(next, tabId), {
					onNone: () => ({ model: next }),
					onSome: (tab) => ({
						model: next,
						commands: [CopyShareLink({ url: shareUrl(next.origin, tab) })],
					}),
				})
			case "delete":
				return (next.tabs?.tabs.length ?? 0) > 1
					? updateDeleteDialog({ ...next, confirmDeleteId: tabId }, Dialog.open(next.deleteDialog))
					: { model: next }
			default:
				return { model: next }
		}
	})()
	return { ...after, commands: [...commands, ...(after.commands ?? [])] }
}

const updateConversationSheet = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, conversationSheet: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotConversationSheetMessage({ message }),
	),
})

/** Picking or creating a conversation in the sheet closes it (`onSelect` / `onCreate`). */
const closingSheet = (model: Model, result: Return): Return => {
	if (!model.conversationSheet.isOpen) return result
	const closed = updateConversationSheet(result.model, Dialog.close(result.model.conversationSheet))
	return {
		...result,
		model: closed.model,
		commands: [...(result.commands ?? []), ...(closed.commands ?? [])],
	}
}

const updateDeleteDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		deleteDialog: step.model,
		confirmDeleteId: step.outMessage?._tag === "Closed" ? null : model.confirmDeleteId,
	},
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

// INIT

const sharedOf = (route: ChatRoute) =>
	route.search.shared === undefined || route.search.shared === ""
		? null
		: {
				tabId: route.search.shared,
				title: route.search.title ?? null,
				focusMessageId: route.search.m ?? null,
			}

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
		conversationSheet: Dialog.init(CONVERSATION_SHEET_ID, "sheet"),
		confirmDeleteId: null,
		referrerPath: null,
		dismissedContexts: [],
		presence: SignalPresenceData.Loading(),
		knownServices: [],
		isKnownServicesRequested: false,
		subject: subjectOfSearch(route.search),
		search: route.search,
	}
	const loaded = withCommands({ model }, [
		LoadTabs({ orgId: context.orgId }),
		LoadPresence({ orgId: context.orgId }),
	])
	return shared === null
		? loaded
		: withCommands(startConversations(model, [shared.tabId], context, "shared"), loaded.commands ?? [])
}

const sameSubject = (a: ChatSubject | null, b: ChatSubject | null): boolean =>
	a === null || b === null
		? a === b
		: subjectTabId(a) === subjectTabId(b) && JSON.stringify(a) === JSON.stringify(b)

/** Back/forward lands a new `?tab=`; a changed `?shared=` is a different view; a new subject gets its tab. */
export const routeChanged = (model: Model, route: ChatRoute, context: PageContext): Return => {
	const shared = sharedOf(route)
	if (shared?.tabId !== model.shared?.tabId) return init(route, context)
	const subject = subjectOfSearch(route.search)
	const next: Model = { ...model, search: route.search, subject }
	if (!sameSubject(subject, model.subject) && subject !== null)
		return { model: next, commands: [StampSubjectTab()] }
	const tab = route.search.tab
	return tab === undefined ? { model: next } : setActive(next, tab, context)
}

// UPDATE

const createTab = (model: Model, id: string, nowMs: number, context: PageContext): Return => {
	if (model.tabs === null) return { model }
	const tab: ChatTab = { id, title: "New chat", createdAt: nowMs, updatedAt: nowMs }
	const saved = saveTabs(model, { tabs: [...model.tabs.tabs, tab], activeTabId: id }, context)
	const started = startConversations(saved.model, [id], context)
	return {
		...started,
		commands: [...(saved.commands ?? []), ...(started.commands ?? [])],
		outMessage: tabUrl(model, id),
	}
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

const step = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedLoadTabs: ({ state, nowMs, origin, referrerPath }) => {
			const urlTab = model.urlTabId
			const tabs =
				urlTab !== null && state.tabs.some((tab) => tab.id === urlTab)
					? { ...state, activeTabId: urlTab }
					: state
			const loaded: Model = { ...model, tabs, nowMs, origin, referrerPath }
			if (model.shared !== null) return { model: loaded }
			const ensured = ensureSubjectTab(loaded, nowMs, context)
			const active = ensured.model.tabs?.activeTabId ?? tabs.activeTabId
			const started = withCommands(
				startConversations(
					ensured.model,
					(ensured.model.tabs ?? tabs).tabs.map((tab) => tab.id),
					context,
				),
				ensured.commands ?? [],
			)
			return urlTab === active ? started : { ...started, outMessage: tabUrl(ensured.model, active) }
		},
		StampedSubjectTab: ({ nowMs }) => {
			const ensured = ensureSubjectTab(model, nowMs, context)
			const active = ensured.model.tabs?.activeTabId
			if (active === undefined || active === model.tabs?.activeTabId) return ensured
			const started = withCommands(
				startConversations(ensured.model, [active], context),
				ensured.commands ?? [],
			)
			return { ...started, outMessage: tabUrl(ensured.model, active) }
		},
		ClickedNewChat: () => closingSheet(model, { model, commands: [CreateTab()] }),
		PressedNewChatKey: () => (model.shared === null ? { model, commands: [CreateTab()] } : { model }),
		CreatedTab: ({ id, nowMs }) => createTab(model, id, nowMs, context),
		ClickedTab: ({ id }) =>
			model.renamingId === id ? { model } : closingSheet(model, setActive(model, id, context)),
		ClickedSidebarTrigger: () => ({ model, outMessage: PageOutMessage.RequestedSidebarToggle() }),
		ClickedSwitchConversation: () => updateConversationSheet(model, Dialog.open(model.conversationSheet)),
		GotConversationSheetMessage: ({ message: child }) =>
			updateConversationSheet(model, Dialog.update(model.conversationSheet, child)),
		ClickedCopyActiveShareLink: () =>
			Option.match(
				Option.flatMap(Option.fromNullishOr(activeTabId(model)), (id) => tabById(model, id)),
				{
					onNone: () => ({ model }),
					onSome: (tab) => ({
						model,
						commands: [CopyShareLink({ url: shareUrl(model.origin, tab) })],
					}),
				},
			),
		DoubleClickedTab: ({ id }) =>
			model.renamingId === id
				? { model }
				: {
						model: {
							...model,
							renamingId: id,
							renameDraft: Option.match(tabById(model, id), {
								onNone: () => "",
								onSome: (tab) => tab.title,
							}),
						},
					},
		ChangedRenameDraft: ({ text }) => ({ model: { ...model, renameDraft: text } }),
		CommittedRename: () => commitRename(model),
		CancelledRename: () => ({ model: { ...model, renamingId: null } }),
		StampedRename: ({ id, title, nowMs }) => renameTab(model, id, title, nowMs, context),
		GotTabMenuMessage: ({ tabId, message: child }) => updateMenu(model, tabId, child),
		GotDeleteDialogMessage: ({ message: child }) =>
			updateDeleteDialog(model, Dialog.update(model.deleteDialog, child)),
		ClickedConfirmDelete: () => {
			const id = model.confirmDeleteId
			if (id === null) return { model }
			const closed = updateDeleteDialog(
				{ ...model, confirmDeleteId: null },
				Dialog.close(model.deleteDialog),
			)
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
				: liftConversation(
						model,
						tabId,
						Conversation.update(conversation, child, sendContext(model, tabId)),
					)
		},
		DismissedContext: ({ id }) =>
			model.dismissedContexts.includes(id)
				? { model }
				: { model: { ...model, dismissedContexts: [...model.dismissedContexts, id] } },
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
			return { model, commands: [TypeIntoComposer({ id: composerId(id), char })] }
		},
		CompletedFocusComposer: () => ({ model }),
		CompletedMountScroller: () => ({ model }),
		CompletedMountStopClick: () => ({ model }),
		CompletedMountRenameInput: () => ({ model }),
	})

/**
 * `WidgetFixAutoSendTrigger`: a ready, empty, active widget-fix thread sends its fix prompt once.
 * A send that never reached the server leaves the thread empty again, so it does not retry.
 */
const followWidgetFix = (result: Return): Return => {
	const model = result.model
	const subject = model.subject
	if (subject?._tag !== "WidgetFix" || model.shared !== null) return result
	const id = subjectTabId(subject)
	const conversation = model.conversations[id]
	if (conversation === undefined || activeTabId(model) !== id) return result
	const isReady =
		conversation.readOnly === null &&
		conversation.historyReady &&
		!ConversationModel.isLoading(conversation) &&
		conversation.messages.length === 0 &&
		conversation.failedSend === null
	if (!isReady) return result
	const sent = liftConversation(
		model,
		id,
		Conversation.update(
			conversation,
			ConversationMessage.ClickedSuggestion({ text: WIDGET_FIX_AUTO_PROMPT }),
			sendContext(model, id),
		),
	)
	return {
		...sent,
		commands: [...(result.commands ?? []), ...(sent.commands ?? [])],
		outMessage: result.outMessage ?? sent.outMessage,
	}
}

const runningTails = (model: Model): string =>
	Object.values(model.conversations)
		.flatMap((conversation) =>
			conversation.stream === null ? [] : [`${conversation.tabId}:${conversation.stream.generation}`],
		)
		.join("|")

/** All tails share one Subscription: when the set changes, each reconnects from what it has folded. */
const followTails = (before: Model, result: Return): Return =>
	runningTails(before) === runningTails(result.model)
		? result
		: {
				...result,
				model: {
					...result.model,
					conversations: Object.fromEntries(
						Object.entries(result.model.conversations).map(([tabId, conversation]) => [
							tabId,
							conversation.stream === null
								? conversation
								: {
										...conversation,
										stream: { ...conversation.stream, cursor: conversation.lastSeq },
									},
						]),
					),
				},
			}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	followTails(model, followWidgetFix(step(model, message, context)))
