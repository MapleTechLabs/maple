import { readChatReferrer } from "../../../components/chat/auto-contexts"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { writeClipboardFallback } from "@maple/ui/lib/clipboard"
import { loadSignalPresences } from "../../kit/signal-presence"
import { Message } from "./message"
import { loadKnownServices } from "../kit/known-services"
import { readTabs, TabsState, writeTabs } from "../kit/tab-store"

export const LoadTabs = Command.define("LoadChatTabs", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadTabs],
	execute: ({ orgId }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const state = yield* readTabs(orgId, nowMs)
			return Message.CompletedLoadTabs({
				state,
				nowMs,
				origin: window.location.origin,
				referrerPath: readChatReferrer(),
			})
		}),
})

export const SaveTabs = Command.define("SaveChatTabs", {
	args: { orgId: Schema.String, state: TabsState },
	messages: [Message.CompletedSaveTabs],
	execute: ({ orgId, state }) => Effect.as(writeTabs(orgId, state), Message.CompletedSaveTabs()),
})

export const CreateTab = Command.define("CreateChatTab", {
	messages: [Message.CreatedTab],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) =>
		Message.CreatedTab({ id: crypto.randomUUID(), nowMs }),
	),
})

export const StampRename = Command.define("StampChatRename", {
	args: { id: Schema.String, title: Schema.String },
	messages: [Message.StampedRename],
	execute: ({ id, title }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) => Message.StampedRename({ id, title, nowMs })),
})

/** `ensureTab`'s clock, for a subject that arrives on a later route change. */
export const StampSubjectTab = Command.define("StampChatSubjectTab", {
	messages: [Message.StampedSubjectTab],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.StampedSubjectTab({ nowMs })),
})

/** `shareUrl`: a read-only link carrying the tab id, its title and an optional message. */
export const shareUrl = (
	origin: string,
	tab: { readonly id: string; readonly title: string },
	messageId?: string,
) => {
	const url = new URL("/chat", origin)
	url.searchParams.set("shared", tab.id)
	const title = tab.title.trim()
	if (title !== "") url.searchParams.set("title", title)
	if (messageId !== undefined) url.searchParams.set("m", messageId)
	return url.toString()
}

/** `useCopy({ label: "Share link" })`: the clipboard, else the hidden-textarea fallback. */
export const CopyShareLink = Command.define("CopyChatShareLink", {
	args: { url: Schema.String },
	messages: [Message.CompletedCopyShareLink],
	execute: ({ url }) =>
		Effect.tryPromise(() => navigator.clipboard.writeText(url)).pipe(
			Effect.as(true),
			Effect.catch(() => Effect.try(() => writeClipboardFallback(url))),
			Effect.orElseSucceed(() => false),
			Effect.map((ok) => Message.CompletedCopyShareLink({ ok })),
		),
})

export const LoadPresence = Command.define("LoadChatSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadPresence({ result })),
})

/** `KnownServicesProvider`: the snapped 24 h services facets probe the overview also runs. */
export const LoadKnownServices = Command.define("LoadChatKnownServices", {
	messages: [Message.CompletedLoadKnownServices],
	execute: Effect.map(loadKnownServices, (services) => Message.CompletedLoadKnownServices({ services })),
})

/**
 * `useTypeAnywhereFocus`: focuses the active composer and types the key at its caret, then fires
 * `input` so the composer's own handler records the text, as a keystroke there would.
 */
export const TypeIntoComposer = Command.define("TypeIntoChatComposer", {
	args: { id: Schema.String, char: Schema.String },
	messages: [Message.CompletedFocusComposer],
	execute: ({ id, char }) =>
		Effect.sync(() => {
			const element = document.getElementById(id)
			if (element instanceof HTMLTextAreaElement && !element.disabled) {
				const start = element.selectionStart
				const end = element.selectionEnd
				element.focus()
				element.value = element.value.slice(0, start) + char + element.value.slice(end)
				element.setSelectionRange(start + char.length, start + char.length)
				element.dispatchEvent(new Event("input", { bubbles: true }))
			}
			return Message.CompletedFocusComposer()
		}),
})
