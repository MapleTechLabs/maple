import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { sidebarTrigger } from "../../../ui/sidebar"
import { truncatedText } from "../../../ui/truncated-text"
import type { PageViewInputs } from "../../contract"
import { presenceOf } from "../../kit/signal-presence"
import type { Model as ConversationModel } from "../conversation/model"
import { conversationView } from "../conversation/view"
import { contextChips } from "../kit/view-composer"
import { MountMessageScroller } from "../kit/scroller"
import { chatEmptyState } from "../kit/view-empty"
import { MountEmptyState, shareUrl } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { activeContexts, composerId, suggestionsOf } from "./update"
import { chatSidebar } from "./view-sidebar"

// `ChatPage` (apps/web components/chat/chat-page.tsx), desktop layout: the conversation rail
// beside every open conversation (hidden but mounted, like legacy's tab panes).
// TODO(chat-mobile): below `md` legacy swaps the rail for a header with a conversation sheet.

type H = HtmlBuilder<Message>

const conversation = (
	h: H,
	model: Model,
	tab: { readonly id: string; readonly title: string },
	state: ConversationModel,
	timeZone: string,
): Html =>
	conversationView(h, state, {
		toMessage: (message) => Message.GotConversationMessage({ tabId: tab.id, message }),
		timeZone,
		textareaId: composerId(tab.id),
		placeholder: "Ask about your system…",
		emptyState: () =>
			chatEmptyState(h, {
				suggestions: suggestionsOf(model),
				onSelect: (text) => Message.GotConversationMessage({ tabId: tab.id, message: { _tag: "ClickedSuggestion", text } }),
				tracePresence: presenceOf(model.presence, "traces"),
				mount: MountEmptyState(),
			}),
		chips: contextChips(h, activeContexts(model), (id) => Message.DismissedContext({ id })),
		permalinkFor: (messageId) => shareUrl(model.origin, tab, messageId),
		scrollerMount: MountMessageScroller(),
		knownServices: new Set(model.knownServices),
		nowMs: model.nowMs,
	})

const conversations = (h: H, model: Model, timeZone: string): Html => {
	const tabs = model.tabs
	return h.div(
		[h.Class("relative min-h-0 flex-1 bg-background")],
		tabs === null
			? []
			: tabs.tabs.flatMap((tab) => {
					const state = model.conversations[tab.id]
					return state === undefined
						? []
						: [
								h.keyed("div")(
									tab.id,
									[h.Class(tab.id === tabs.activeTabId ? "flex h-full flex-col" : "hidden")],
									[conversation(h, model, tab, state, timeZone)],
								),
							]
				}),
	)
}

/** `SharedChatView`: a teammate's conversation, read-only, under its own header. */
const sharedView = (h: H, model: Model, timeZone: string): Html => {
	const shared = model.shared
	const state = shared === null ? undefined : model.conversations[shared.tabId]
	const heading = shared?.title?.trim() || "Shared conversation"
	return h.div(
		[h.Class("flex h-full min-h-0 flex-1 flex-col")],
		[
			h.header(
				[h.Class("flex h-12 shrink-0 items-center gap-2 border-b bg-sidebar px-2 text-sidebar-foreground")],
				[
					sidebarTrigger(h, { state: "collapsed", className: "size-9" }),
					icon(h, "LinkIcon", { size: 14, className: "shrink-0 text-muted-foreground/70" }),
					h.div(
						[h.Class("flex min-w-0 flex-1 flex-col justify-center")],
						[
							truncatedText(h, { text: heading, className: "text-sm font-medium leading-tight" }, [heading]),
							eyebrow(h, { className: "leading-tight text-sidebar-foreground/60" }, ["Read-only · shared"]),
						],
					),
					linkButton(h, { href: "/chat", variant: "outline", size: "sm", className: "shrink-0 gap-1.5" }, [
						icon(h, "PlusIcon"),
						"New chat",
					]),
				],
			),
			h.div(
				[h.Class("relative min-h-0 flex-1 bg-background")],
				[
					h.div(
						[h.Class("flex h-full flex-col")],
						shared === null || state === undefined
							? []
							: [
									conversationView(h, state, {
										toMessage: (message) => Message.GotConversationMessage({ tabId: shared.tabId, message }),
										timeZone,
										textareaId: composerId(shared.tabId),
										placeholder: "Ask about your system…",
										emptyState: () => h.empty,
										chips: [],
										scrollerMount: MountMessageScroller(),
										knownServices: new Set(model.knownServices),
										nowMs: model.nowMs,
										permalinkFor: (messageId) =>
											shareUrl(model.origin, { id: shared.tabId, title: shared.title ?? "" }, messageId),
									}),
								],
					),
				],
			),
		],
	)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	model.shared !== null
		? sharedView(h, model, inputs.context.timeZone)
		: h.div(
				[h.Class("flex h-full min-h-0 flex-1")],
				[
					chatSidebar(h, model, "w-[260px] border-r"),
					h.div([h.Class("flex min-w-0 flex-1 flex-col")], [conversations(h, model, inputs.context.timeZone)]),
				],
			),
)
