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
import { shareUrl } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { activeContexts, activeTabId, composerId, subjectFor, suggestionsOf } from "./update"
import { Message as ConversationMessage } from "../conversation/message"
import { emptyNotice } from "../conversation/view"
import { investigationNoun } from "../../investigations/detail/investigation-context"
import { investigationCard, widgetFixCard } from "../kit/view-subject"
import { mobileLayout } from "./view-mobile"
import { chatSidebar } from "./view-sidebar"

// The chat page, desktop layout: the conversation rail beside every open conversation (hidden
// but mounted, so each keeps its state).
// Below `md` the rail becomes a header with a conversation sheet (`view-mobile.ts`).

type H = HtmlBuilder<Message>

const conversation = (
	h: H,
	model: Model,
	tab: { readonly id: string; readonly title: string },
	state: ConversationModel,
	timeZone: string,
): Html => {
	const subject = subjectFor(model, tab.id)
	const onSelect = (text: string) =>
		Message.GotConversationMessage({
			tabId: tab.id,
			message: ConversationMessage.ClickedSuggestion({ text }),
		})
	const suggestions = suggestionsOf(model, tab.id)
	return conversationView(h, state, {
		toMessage: (message) => Message.GotConversationMessage({ tabId: tab.id, message }),
		timeZone,
		textareaId: composerId(tab.id),
		placeholder:
			subject === null
				? "Ask about your system…"
				: subject._tag === "Investigation"
					? `Ask about this ${investigationNoun(subject.context.kind)}…`
					: "Ask about this widget…",
		emptyState: () =>
			subject === null
				? chatEmptyState(h, {
						suggestions,
						onSelect,
						tracePresence: presenceOf(model.presence, "traces"),
					})
				: subject._tag === "Investigation"
					? emptyNotice(
							h,
							"Ready to investigate",
							`This ${investigationNoun(subject.context.kind)} is attached to every message in the thread. Start with a suggestion or ask your own question.`,
						)
					: emptyNotice(
							h,
							"Diagnosing widget…",
							"Maple AI is reading the broken widget config and the validation error. It will propose a corrected widget JSON for you to approve.",
						),
		chips:
			subject === null
				? contextChips(h, activeContexts(model), (id) => Message.DismissedContext({ id }))
				: [],
		permalinkFor: (messageId) => shareUrl(model.origin, tab, messageId),
		scrollerMount: MountMessageScroller({
			focusMessageId: tab.id === activeTabId(model) ? (model.search.m ?? null) : null,
		}),
		knownServices: new Set(model.knownServices),
		nowMs: model.nowMs,
		...(subject === null
			? undefined
			: {
					suggestions: { items: suggestions, onSelect },
					header: [
						subject._tag === "Investigation"
							? investigationCard(h, subject.context)
							: widgetFixCard(h, subject.context),
					],
				}),
	})
}

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
									[
										h.Class(
											tab.id === tabs.activeTabId ? "flex h-full flex-col" : "hidden",
										),
									],
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
				[
					h.Class(
						"flex h-12 shrink-0 items-center gap-2 border-b bg-sidebar px-2 text-sidebar-foreground",
					),
				],
				[
					sidebarTrigger(h, {
						state: "collapsed",
						className: "size-9",
						attributes: [h.OnClick(Message.ClickedSidebarTrigger())],
					}),
					icon(h, "LinkIcon", { size: 14, className: "shrink-0 text-muted-foreground/70" }),
					h.div(
						[h.Class("flex min-w-0 flex-1 flex-col justify-center")],
						[
							truncatedText(
								h,
								{ text: heading, className: "text-sm font-medium leading-tight" },
								[heading],
							),
							eyebrow(h, { className: "leading-tight text-sidebar-foreground/60" }, [
								"Read-only · shared",
							]),
						],
					),
					linkButton(
						h,
						{ href: "/chat", variant: "outline", size: "sm", className: "shrink-0 gap-1.5" },
						[icon(h, "PlusIcon"), "New chat"],
					),
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
										toMessage: (message) =>
											Message.GotConversationMessage({ tabId: shared.tabId, message }),
										timeZone,
										textareaId: composerId(shared.tabId),
										placeholder: "Ask about your system…",
										emptyState: () => h.empty,
										chips: [],
										scrollerMount: MountMessageScroller({
											focusMessageId: shared.focusMessageId,
										}),
										knownServices: new Set(model.knownServices),
										nowMs: model.nowMs,
										permalinkFor: (messageId) =>
											shareUrl(
												model.origin,
												{ id: shared.tabId, title: shared.title ?? "" },
												messageId,
											),
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
		: inputs.isMobile === true
			? mobileLayout(h, model, conversations(h, model, inputs.context.timeZone))
			: h.div(
					[h.Class("flex h-full min-h-0 flex-1")],
					[
						chatSidebar(h, model, "w-[260px] border-r"),
						h.div(
							[h.Class("flex min-w-0 flex-1 flex-col")],
							[conversations(h, model, inputs.context.timeZone)],
						),
					],
				),
)
