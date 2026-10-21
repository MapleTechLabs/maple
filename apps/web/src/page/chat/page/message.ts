import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { SignalPresences } from "../../kit/signal-presence"
import { Message as ConversationMessage } from "../conversation/message"
import { TabsState } from "./model"

export const Message = defineMessageUnion({
	CompletedLoadTabs: {
		state: TabsState,
		nowMs: Schema.Number,
		origin: Schema.String,
		referrerPath: Schema.NullOr(Schema.String),
	},
	ClickedNewChat: {},
	/** `crypto.randomUUID()` and the clock, for a new tab. */
	CreatedTab: { id: Schema.String, nowMs: Schema.Number },
	ClickedTab: { id: Schema.String },
	DoubleClickedTab: { id: Schema.String },
	ChangedRenameDraft: { text: Schema.String },
	/** Enter or blur: a changed, non-empty title is applied; anything else cancels. */
	CommittedRename: {},
	CancelledRename: {},
	StampedRename: { id: Schema.String, title: Schema.String, nowMs: Schema.Number },
	/** The clock for `ensureTab` of a subject the route brought after the tabs were read. */
	StampedSubjectTab: { nowMs: Schema.Number },
	GotTabMenuMessage: { tabId: Schema.String, message: Menu.Message },
	GotDeleteDialogMessage: { message: Dialog.Message },
	ClickedConfirmDelete: {},
	/** Below `md`, the page's own header: its `SidebarTrigger`, title switch and share button. */
	ClickedSidebarTrigger: {},
	ClickedSwitchConversation: {},
	ClickedCopyActiveShareLink: {},
	GotConversationSheetMessage: { message: Dialog.Message },
	CompletedSaveTabs: {},
	CompletedCopyShareLink: { ok: Schema.Boolean },
	GotConversationMessage: { tabId: Schema.String, message: ConversationMessage },
	DismissedContext: { id: Schema.String },
	CompletedLoadPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	CompletedLoadKnownServices: { services: Schema.Array(Schema.String) },
	/** `Mod+Shift+O`. */
	PressedNewChatKey: {},
	/** A printable key with nothing focused lands in the active composer. */
	TypedAnywhere: { char: Schema.String },
	CompletedFocusComposer: {},
	CompletedMountScroller: {},
	CompletedMountStopClick: {},
	CompletedMountRenameInput: {},
})
export type Message = typeof Message.Type
