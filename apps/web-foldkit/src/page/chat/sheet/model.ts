import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import * as Tooltip from "../../../ui/tooltip"
import { SignalPresenceData, SignalPresences } from "../../kit/signal-presence"
import { Message as ConversationMessage } from "../conversation/message"
import * as Conversation from "../conversation/model"

// `GlobalChatSheet` + `GlobalChatPanel` (apps/web components/chat): the app-wide chat slide-over,
// opened from the top bar's "Ask Maple AI", the command palette or `C`, on the org's quick thread
// (or the conversation it last showed). Its content mounts only while open.

export const SHEET_ID = "chat-sheet"

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	/** The header buttons' tooltips (`<TooltipPopup side="bottom">`), one popup for both. */
	tooltip: Tooltip.Model,
	/**
	 * Base UI tracks the interaction modality: the dialog's initial focus after a pointer open opens
	 * no tooltip, after `C` it does. Cleared once focus leaves the button it landed on.
	 */
	isInitialFocusPointer: Schema.Boolean,
	/** The org the open sheet belongs to; `null` while closed. */
	orgId: Schema.NullOr(Schema.String),
	tabId: Schema.String,
	/** `null` until the sheet's stored tab has been read, and again once it closed. */
	conversation: Schema.NullOr(Conversation.Model),
	nowMs: Schema.Number,
	presence: SignalPresenceData.schema,
	isPresenceRequested: Schema.Boolean,
	knownServices: Schema.Array(Schema.String),
	isKnownServicesRequested: Schema.Boolean,
	/** `readChatReferrer()` when the thread mounted, and the context chips dismissed since. */
	referrerPath: Schema.NullOr(Schema.String),
	dismissedContexts: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

export const init = (): Model => ({
	dialog: Dialog.init(SHEET_ID, "sheet"),
	tooltip: Tooltip.init("chat-sheet-tooltip", { side: "bottom" }),
	isInitialFocusPointer: false,
	orgId: null,
	tabId: "quick",
	conversation: null,
	nowMs: 0,
	presence: SignalPresenceData.Idle(),
	isPresenceRequested: false,
	knownServices: [],
	isKnownServicesRequested: false,
	referrerPath: null,
	dismissedContexts: [],
})

export const Message = defineMessageUnion({
	/** "Ask Maple AI", the palette's action or `C` (`openGlobalChat`). */
	RequestedOpen: { viaKeyboard: Schema.Boolean },
	CompletedReadSheetTab: {
		orgId: Schema.String,
		tabId: Schema.String,
		nowMs: Schema.Number,
		referrerPath: Schema.NullOr(Schema.String),
	},
	GotDialogMessage: { message: Dialog.Message },
	GotTooltipMessage: { message: Tooltip.Message },
	/** A header button took keyboard focus (`:focus-visible`), which opens its tooltip. */
	FocusedVisibleTrigger: { triggerId: Schema.String },
	/** The pointer moved over a header button (a sheet sliding in under a resting pointer is no hover). */
	MovedOverTrigger: { triggerId: Schema.String },
	ClickedNewChat: {},
	CreatedSheetTab: { orgId: Schema.String, tabId: Schema.String, referrerPath: Schema.NullOr(Schema.String) },
	DismissedContext: { id: Schema.String },
	ClickedOpenFullPage: {},
	CompletedEnsureStoredTab: { tabId: Schema.String },
	CompletedRenameStoredTab: {},
	GotConversationMessage: { message: ConversationMessage },
	PaintedEmptyState: {},
	CompletedLoadPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	CompletedLoadKnownServices: { services: Schema.Array(Schema.String) },
	CompletedMountScroller: {},
	CompletedReleaseFocus: {},
})
export type Message = typeof Message.Type

/** What the root acts on: a toast (an applied approval). */
export const OutMessage = defineMessageUnion({
	RequestedToast: { type: Schema.Literals(["success", "error"]), title: Schema.String },
})
export type OutMessage = typeof OutMessage.Type
