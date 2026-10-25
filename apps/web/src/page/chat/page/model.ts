import { Schema } from "effect"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { SignalPresenceData } from "../../kit/signal-presence"
import { ChatSearch } from "../../../route/search"
import { ChatSubject } from "../kit/subject"
import { TabsState } from "../kit/tab-store"
import * as Conversation from "../conversation/model"

// `/chat`: the conversation rail and its open tabs.

export { ChatTab, TabsState } from "../kit/tab-store"

/** `?shared=`: a teammate's conversation, read-only, never added to the viewer's own tabs. */
export const SharedView = Schema.Struct({
	tabId: Schema.String,
	title: Schema.NullOr(Schema.String),
	focusMessageId: Schema.NullOr(Schema.String),
})
export type SharedView = typeof SharedView.Type

export const Model = Schema.Struct({
	/** `null` until the stored tabs have been read. */
	tabs: Schema.NullOr(TabsState),
	/** The `?tab=` the route asked for; applied once the tabs are read. */
	urlTabId: Schema.NullOr(Schema.String),
	shared: Schema.NullOr(SharedView),
	/** The clock when the tabs were read: the sidebar's Today / Yesterday grouping. */
	nowMs: Schema.Number,
	/** `window.location.origin`, for share links and permalinks. */
	origin: Schema.String,
	conversations: Schema.Record(Schema.String, Conversation.Model),
	renamingId: Schema.NullOr(Schema.String),
	renameDraft: Schema.String,
	menus: Schema.Record(Schema.String, Menu.Model),
	deleteDialog: Dialog.Model,
	/** Below `md`: the conversation list as a left sheet (`convListOpen`). */
	conversationSheet: Dialog.Model,
	confirmDeleteId: Schema.NullOr(Schema.String),
	/** `maple-chat-referrer`: the page the user came from, for the composer's context chips. */
	referrerPath: Schema.NullOr(Schema.String),
	dismissedContexts: Schema.Array(Schema.String),
	presence: SignalPresenceData.schema,
	/** The org's service names (the shared 24 h facets probe), for chat tables' service links. */
	knownServices: Schema.Array(Schema.String),
	isKnownServicesRequested: Schema.Boolean,
	/** `?mode=alert` / `?mode=widget-fix`: the subject its own tab is about. */
	subject: Schema.NullOr(ChatSubject),
	/** The route's search, kept when `?tab=` is rewritten (`url.searchParams.set`). */
	search: ChatSearch,
})
export type Model = typeof Model.Type

export const DELETE_DIALOG_ID = "chat-delete-conversation"
export const CONVERSATION_SHEET_ID = "chat-conversation-sheet"
