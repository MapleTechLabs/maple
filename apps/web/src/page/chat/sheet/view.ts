import { sheetTitleStyles } from "@maple/ui/styles/ui/sheet"
import { cn } from "@maple/ui/lib/utils"
import { Submodel } from "foldkit"
import { Predicate } from "effect"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "../../../ui/button"
import * as Dialog from "../../../ui/dialog"
import * as DialogView from "../../../ui/dialog-view"
import { icon } from "../../../ui/icon"
import * as Tooltip from "../../../ui/tooltip"
import { presenceOf } from "../../kit/signal-presence"
import { Message as ConversationMessage } from "../conversation/message"
import { conversationView } from "../conversation/view"
import { MountMessageScroller } from "../kit/scroller"
import { chatEmptyState } from "../kit/view-empty"
import { contextChips } from "../kit/view-composer"
import { activeContextsOf } from "../kit/preamble"
import { suggestionsForContexts } from "../../../components/chat/auto-contexts"
import { DEFAULT_SUGGESTIONS } from "../page/update"
import { MountFocusVisibleTrigger } from "./command"
import { Message, type Model, SHEET_ID } from "./model"

// `GlobalChatPanel`'s sheet: Maple AI header with New chat and Open full page, the conversation.

export type SheetViewInputs = Readonly<{ timeZone: string }>

const toConversation = (tabId: string) => (message: ConversationMessage) => Message.GotConversationMessage({ tabId, message })

const NEW_CHAT_TRIGGER = "chat-sheet-new-chat"
const OPEN_FULL_PAGE_TRIGGER = "chat-sheet-open-full-page"

const TOOLTIP_TEXT = new Map([
	[NEW_CHAT_TRIGGER, "Start a new conversation"],
	[OPEN_FULL_PAGE_TRIGGER, "Open this chat in the full page view"],
])

/** The tooltip trigger's attributes minus focus and enter: `MountFocusVisibleTrigger` reports those. */
const withoutFocus = (attributes: ReadonlyArray<ChildAttribute>): ReadonlyArray<ChildAttribute> =>
	attributes.filter(
		(child) =>
			!(
				Predicate.hasProperty(child.attribute, "_tag") &&
				(child.attribute._tag === "OnFocus" || child.attribute._tag === "OnMouseEnter")
			),
	)

/** New chat and Open full page, each a `TooltipTrigger` (`render={<Button />}`). */
const headerActions = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.submodel({
		slotId: "chat-sheet-tooltip",
		model: model.tooltip,
		view: Tooltip.view,
		toParentMessage: (message) => Message.GotTooltipMessage({ message }),
		viewInputs: {
			triggerIds: [NEW_CHAT_TRIGGER, OPEN_FULL_PAGE_TRIGGER],
			toContent: (triggerId) => [TOOLTIP_TEXT.get(triggerId) ?? ""],
			toView: ({ trigger, portal }) =>
				h.div(
					[h.Class("ms-auto flex items-center gap-1.5")],
					[
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								slot: "tooltip-trigger",
								attributes: [
									...withoutFocus(trigger(NEW_CHAT_TRIGGER)),
									h.OnMount(MountFocusVisibleTrigger({ triggerId: NEW_CHAT_TRIGGER })),
									h.OnClick(Message.ClickedNewChat()),
								],
							},
							["New chat"],
						),
						linkButton(
							h,
							{
								href: `/chat?tab=${encodeURIComponent(model.tabId)}`,
								size: "icon-sm",
								variant: "ghost",
								slot: "tooltip-trigger",
								attributes: [
									h.AriaLabel("Open full page"),
									...withoutFocus(trigger(OPEN_FULL_PAGE_TRIGGER)),
									h.OnMount(MountFocusVisibleTrigger({ triggerId: OPEN_FULL_PAGE_TRIGGER })),
									h.OnClick(Message.ClickedOpenFullPage()),
								],
							},
							[icon(h, "MaximizeIcon", { className: "size-4" })],
						),
						h.div([h.AriaHidden(true), h.Class("ms-0.5 h-4 w-px bg-border")], []),
						...(portal === null ? [] : [portal]),
					],
				),
		},
	})

const header = (h: HtmlBuilder<Message>, model: Model): Html =>
	DialogView.dialogHeader(
		h,
		"sheet",
		[
			h.h2(
				[
					h.Class(cn(sheetTitleStyles, "flex min-w-0 items-center gap-2 text-sm")),
					h.DataAttribute("slot", "sheet-title"),
					h.Id(Dialog.titleId(SHEET_ID)),
				],
				[
					icon(h, "MapleMark", { size: 16, className: "shrink-0 text-primary", attributes: [h.AriaHidden(true)] }),
					h.span(
						[h.Class("truncate")],
						[
							"Maple",
							" ",
							h.span([h.Class("shimmer shimmer-color-primary shimmer-duration-3200 shimmer-spread-[2ch]")], ["AI"]),
						],
					),
				],
			),
			h.p(
				[
					h.Class("text-muted-foreground text-sm sr-only"),
					h.DataAttribute("slot", "sheet-description"),
					h.Id(Dialog.descriptionId(SHEET_ID)),
				],
				["Ask about your services, traces, errors, and alerts."],
			),
			headerActions(h, model),
		],
		"h-11 flex-row items-center gap-1 border-b px-3 py-0 pe-11",
	)

/** Keyed by the thread (`<GlobalChatContent key={tabId}>`): a new chat mounts afresh. */
const content = (h: HtmlBuilder<Message>, model: Model, inputs: SheetViewInputs): Html => {
	// `PageContextChips` and `suggestionsForContexts`: the page the sheet was opened over.
	const contexts = activeContextsOf(model.referrerPath, model.dismissedContexts)
	return h.keyed("div")(
		model.tabId,
		[h.Class("flex min-h-0 flex-1 flex-col")],
		model.conversation === null
			? []
			: [
					conversationView(h, model.conversation, {
						toMessage: toConversation(model.tabId),
						timeZone: inputs.timeZone,
						textareaId: `chat-sheet-composer-${model.tabId}`,
						placeholder: "Ask about your system…",
						emptyState: () =>
							chatEmptyState(h, {
								suggestions: suggestionsForContexts([...contexts]) ?? DEFAULT_SUGGESTIONS,
								onSelect: (text) => toConversation(model.tabId)(ConversationMessage.ClickedSuggestion({ text })),
								tracePresence: presenceOf(model.presence, "traces"),
							}),
						chips: contextChips(h, contexts, (id) => Message.DismissedContext({ id })),
						scrollerMount: MountMessageScroller({ focusMessageId: null }),
						knownServices: new Set(model.knownServices),
						nowMs: model.nowMs,
					}),
				],
	)
}

/** The sheet's portal (Base UI appends it to `<body>`); nothing while closed. */
export const view = Submodel.defineView<Model, Message, SheetViewInputs>((model, inputs, h) =>
	h.submodel({
		slotId: "chat-sheet-dialog",
		model: model.dialog,
		view: DialogView.view,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		viewInputs: {
			hasTrigger: false,
			side: "right",
			className: "w-[calc(100%-(--spacing(12)))] sm:max-w-2xl",
			closeClassName: "absolute end-2 top-1.5 z-10",
			toView: ({ portal }) => portal ?? h.empty,
			toContent: () => [header(h, model), content(h, model, inputs)],
		},
	}),
)
