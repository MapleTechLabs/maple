import { readChatReferrer } from "@maple/web/components/chat/auto-contexts"
import { formatWarehouseDateTime, snapRangeForCache } from "@maple/query-engine"
import { Clock, Effect, Option, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { ServicesFacetsProbe } from "../../../data/services-facets-probe"
import { writeClipboardFallback } from "@maple/ui/lib/clipboard"
import { loadSignalPresences } from "../../kit/signal-presence"
import { Message } from "./message"
import { DEFAULT_TAB_ID, TabsState } from "./model"

const storageKey = (orgId: string) => `maple-chat-tabs:${orgId}`

const StoredTabs = Schema.fromJsonString(
	Schema.Struct({
		tabs: Schema.Array(
			Schema.Struct({
				id: Schema.String,
				title: Schema.String,
				createdAt: Schema.Number,
				updatedAt: Schema.optionalKey(Schema.Number),
			}),
		),
		activeTabId: Schema.String,
	}),
)
const decodeStoredTabs = Schema.decodeUnknownOption(StoredTabs)
const encodeTabs = Schema.encodeSync(Schema.fromJsonString(TabsState))

/** `loadState`: the stored tabs (older ones lack `updatedAt`), else one fresh "New Chat". */
const readTabs = (orgId: string, nowMs: number): TabsState =>
	Option.getOrElse(
		Option.filter(
			Option.flatMap(Option.fromNullishOr(localStorage.getItem(storageKey(orgId))), decodeStoredTabs),
			(stored) => stored.tabs.length > 0 && stored.activeTabId !== "",
		).pipe(
			Option.map(
				(stored): TabsState => ({
					activeTabId: stored.activeTabId,
					tabs: stored.tabs.map((tab) => ({ ...tab, updatedAt: tab.updatedAt ?? tab.createdAt })),
				}),
			),
		),
		(): TabsState => ({
			tabs: [{ id: DEFAULT_TAB_ID, title: "New Chat", createdAt: nowMs, updatedAt: nowMs }],
			activeTabId: DEFAULT_TAB_ID,
		}),
	)

export const LoadTabs = Command.define("LoadChatTabs", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadTabs],
	execute: ({ orgId }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const state = yield* Effect.orElseSucceed(
				Effect.try(() => readTabs(orgId, nowMs)),
				(): TabsState => ({
					tabs: [{ id: DEFAULT_TAB_ID, title: "New Chat", createdAt: nowMs, updatedAt: nowMs }],
					activeTabId: DEFAULT_TAB_ID,
				}),
			)
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
	execute: ({ orgId, state }) =>
		Effect.as(
			Effect.ignore(Effect.try(() => localStorage.setItem(storageKey(orgId), encodeTabs(state)))),
			Message.CompletedSaveTabs(),
		),
})

export const CreateTab = Command.define("CreateChatTab", {
	messages: [Message.CreatedTab],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CreatedTab({ id: crypto.randomUUID(), nowMs })),
})

export const StampRename = Command.define("StampChatRename", {
	args: { id: Schema.String, title: Schema.String },
	messages: [Message.StampedRename],
	execute: ({ id, title }) => Effect.map(Clock.currentTimeMillis, (nowMs) => Message.StampedRename({ id, title, nowMs })),
})

/** `shareUrl`: a read-only link carrying the tab id, its title and an optional message. */
export const shareUrl = (origin: string, tab: { readonly id: string; readonly title: string }, messageId?: string) => {
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
	messages: [Message.CompletedLoadPresence],
	execute: Effect.map(loadSignalPresences, (result) => Message.CompletedLoadPresence({ result })),
})

/** `KnownServicesProvider`: the snapped 24 h services facets probe the overview also runs. */
export const LoadKnownServices = Command.define("LoadChatKnownServices", {
	messages: [Message.CompletedLoadKnownServices],
	execute: Effect.gen(function* () {
		const end = yield* Clock.currentTimeMillis
		const range = snapRangeForCache({
			startTime: formatWarehouseDateTime(end - 24 * 60 * 60 * 1000),
			endTime: formatWarehouseDateTime(end),
		})
		const response = yield* (yield* ServicesFacetsProbe).load(range)
		return Message.CompletedLoadKnownServices({
			services: response.data.services.map((service) => service.name).filter((name) => name !== ""),
		})
	}).pipe(Effect.orElseSucceed(() => Message.CompletedLoadKnownServices({ services: [] }))),
})

/** Focuses the active composer, caret at the end (`useTypeAnywhereFocus`). */
export const FocusComposer = Command.define("FocusChatComposer", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusComposer],
	execute: ({ id }) =>
		Effect.sync(() => {
			const element = document.getElementById(id)
			if (element instanceof HTMLTextAreaElement) {
				element.focus()
				element.setSelectionRange(element.value.length, element.value.length)
			}
			return Message.CompletedFocusComposer()
		}),
})

/** The empty state painted: legacy's `useSignalPresence` only asks once it mounts. */
export const MountEmptyState = Mount.define("MountChatEmptyState", {
	messages: [Message.PaintedEmptyState],
	execute: () =>
		Effect.callback<ReturnType<typeof Message.PaintedEmptyState>>((resume) => {
			const handle = requestAnimationFrame(() =>
				requestAnimationFrame(() => resume(Effect.succeed(Message.PaintedEmptyState()))),
			)
			return Effect.sync(() => cancelAnimationFrame(handle))
		}),
})
