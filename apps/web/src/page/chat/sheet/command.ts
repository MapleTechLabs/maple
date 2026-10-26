import { readChatReferrer } from "../../../components/chat/auto-contexts"
import { Clock, Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { loadSignalPresences } from "../../kit/signal-presence"
import { loadKnownServices } from "../kit/known-services"
import {
	appendStoredTab,
	ensureStoredTab,
	loadSheetTab,
	QUICK_CHAT_TAB_ID,
	renameStoredTab,
	saveSheetTab,
} from "../kit/tab-store"
import * as Dialog from "../../../ui/dialog"
import { Message, SHEET_ID } from "./model"

/** `loadSheetTab`: the conversation the sheet last showed for this org, else the quick thread. */
export const ReadSheetTab = Command.define("ReadChatSheetTab", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedReadSheetTab],
	execute: ({ orgId }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const tabId = yield* loadSheetTab(orgId, nowMs)
			return Message.CompletedReadSheetTab({ orgId, tabId, nowMs, referrerPath: readChatReferrer() })
		}),
})

/** The sheet's New chat: a tab in the org's list (`createTab`), remembered as the sheet's. */
export const CreateSheetTab = Command.define("CreateChatSheetTab", {
	args: { orgId: Schema.String },
	messages: [Message.CreatedSheetTab],
	execute: ({ orgId }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const tabId = crypto.randomUUID()
			yield* appendStoredTab(orgId, tabId, nowMs)
			yield* saveSheetTab(orgId, tabId)
			return Message.CreatedSheetTab({ orgId, tabId, referrerPath: readChatReferrer() })
		}),
})

/**
 * Focus leaves the closing sheet while it is still on screen: a focused header button removed with
 * the popup would report its blur after the sheet's boundary is gone (Chromium blurs on removal).
 */
export const ReleaseFocus = Command.define("ReleaseChatSheetFocus", {
	messages: [Message.CompletedReleaseFocus],
	execute: Effect.sync(() => {
		const active = document.activeElement
		if (active instanceof HTMLElement && active.closest(`#${Dialog.popupId(SHEET_ID)}`) !== null)
			active.blur()
		return Message.CompletedReleaseFocus()
	}),
})

/** Open full page: the sheet's thread registered (and active) in the tab list before `/chat` opens. */
export const EnsureStoredTab = Command.define("EnsureChatSheetTab", {
	args: { orgId: Schema.String, tabId: Schema.String },
	messages: [Message.CompletedEnsureStoredTab],
	execute: ({ orgId, tabId }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			yield* ensureStoredTab(
				orgId,
				tabId,
				tabId === QUICK_CHAT_TAB_ID ? "Quick chat" : "New chat",
				nowMs,
			)
			return Message.CompletedEnsureStoredTab({ tabId })
		}),
})

/** `onFirstMessage={renameTab}`. */
export const RenameStoredTab = Command.define("RenameChatSheetTab", {
	args: { orgId: Schema.String, tabId: Schema.String, title: Schema.String },
	messages: [Message.CompletedRenameStoredTab],
	execute: ({ orgId, tabId, title }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			yield* renameStoredTab(orgId, tabId, title, nowMs)
			return Message.CompletedRenameStoredTab()
		}),
})

export const LoadPresence = Command.define("LoadChatSheetSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadPresence({ orgId, result })),
})

export const LoadKnownServices = Command.define("LoadChatSheetKnownServices", {
	messages: [Message.CompletedLoadKnownServices],
	execute: Effect.map(loadKnownServices, (services) => Message.CompletedLoadKnownServices({ services })),
})

/**
 * The header buttons' tooltip triggers. Hover is a pointer move over the button, not an enter (the
 * sheet slides in under a resting pointer). Base UI opens a tooltip on keyboard focus only: the dialog's initial focus after a pointer open
 * is not `:focus-visible` and opens nothing; after `C` it is, and the first button's tooltip shows.
 */
export const MountFocusVisibleTrigger = Mount.defineStream("MountChatSheetFocusVisibleTrigger", {
	args: { triggerId: Schema.String },
	messages: [Message.FocusedVisibleTrigger, Message.MovedOverTrigger],
	execute: ({ element, triggerId }) =>
		Stream.callback<
			ReturnType<typeof Message.FocusedVisibleTrigger> | ReturnType<typeof Message.MovedOverTrigger>
		>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const onFocus = () => {
						if (element.matches(":focus-visible"))
							Queue.offerUnsafe(queue, Message.FocusedVisibleTrigger({ triggerId }))
					}
					const onMove = () => Queue.offerUnsafe(queue, Message.MovedOverTrigger({ triggerId }))
					element.addEventListener("focus", onFocus)
					element.addEventListener("mousemove", onMove)
					return () => {
						element.removeEventListener("focus", onFocus)
						element.removeEventListener("mousemove", onMove)
					}
				}),
				(release) => Effect.sync(release),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
