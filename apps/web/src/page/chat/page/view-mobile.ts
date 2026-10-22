import type { Html, HtmlBuilder } from "foldkit/html"
import * as DialogView from "../../../ui/dialog-view"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { sidebarTrigger } from "../../../ui/sidebar"
import { Message } from "./message"
import type { Model } from "./model"
import { chatSidebar } from "./view-sidebar"

// The chat page below `md`: a header with the sidebar
// trigger, the active conversation's title (opens the list as a sheet), share and new chat.

type H = HtmlBuilder<Message>

const header = (h: H, model: Model): Html => {
	const activeTitle =
		model.tabs?.tabs.find((tab) => tab.id === model.tabs?.activeTabId)?.title ?? "New chat"
	return h.header(
		[h.Class("flex h-12 shrink-0 items-center gap-1 border-b bg-sidebar px-2 text-sidebar-foreground")],
		[
			// `SidebarProvider open={false}`: the trigger always shows the collapsed glyph.
			sidebarTrigger(h, {
				state: "collapsed",
				className: "size-9",
				attributes: [h.OnClick(Message.ClickedSidebarTrigger())],
			}),
			h.button(
				[
					h.Type("button"),
					h.OnClick(Message.ClickedSwitchConversation()),
					h.Class(
						"flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-sidebar-accent/50",
					),
					h.AriaLabel("Switch conversation"),
				],
				[
					h.span([h.Class("truncate text-sm font-medium")], [activeTitle]),
					icon(h, "ChevronDownIcon", { size: 14, className: "shrink-0 text-muted-foreground/70" }),
				],
			),
			iconButton(
				h,
				{
					label: "Copy share link",
					size: "icon",
					className: "size-9",
					attributes: [h.OnClick(Message.ClickedCopyActiveShareLink())],
				},
				[icon(h, "LinkIcon")],
			),
			iconButton(
				h,
				{
					label: "New chat",
					size: "icon",
					className: "size-9",
					attributes: [h.OnClick(Message.ClickedNewChat())],
				},
				[icon(h, "PlusIcon")],
			),
		],
	)
}

/** `<Sheet open={convListOpen}>`: the conversation rail, full width, on the left. */
const conversationSheet = (h: H, model: Model): Html =>
	h.submodel({
		slotId: "chat-conversation-sheet",
		model: model.conversationSheet,
		view: DialogView.view,
		viewInputs: {
			className: "w-[300px] max-w-[85vw] bg-sidebar p-0",
			side: "left",
			hasTrigger: false,
			toView: ({ portal }) => portal,
			toContent: () => [
				DialogView.dialogHeader(
					h,
					"sheet",
					[
						DialogView.dialogTitle(h, "sheet", model.conversationSheet.id, "Conversations"),
						DialogView.dialogDescription(
							h,
							"sheet",
							model.conversationSheet.id,
							"Switch between chat conversations.",
						),
					],
					"sr-only",
				),
				chatSidebar(h, model, "w-full"),
			],
		},
		toParentMessage: (message) => Message.GotConversationSheetMessage({ message }),
	})

export const mobileLayout = (h: H, model: Model, conversationArea: Html): Html =>
	h.div(
		[h.Class("flex h-full min-h-0 flex-1 flex-col")],
		[header(h, model), conversationArea, conversationSheet(h, model)],
	)
