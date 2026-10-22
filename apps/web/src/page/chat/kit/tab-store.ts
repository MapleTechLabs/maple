import { Effect, Option, Schema } from "effect"

// The chat tabs' storage: `maple-chat-tabs:<orgId>` and the
// global sheet's `maple-chat-sheet-tab:<orgId>`, in localStorage. Effects, run from Commands.

export const ChatTab = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
})
export type ChatTab = typeof ChatTab.Type

export const TabsState = Schema.Struct({ tabs: Schema.Array(ChatTab), activeTabId: Schema.String })
export type TabsState = typeof TabsState.Type

export const DEFAULT_TAB_ID = "default"
/** The global sheet's org-scoped thread (`QUICK_CHAT_TAB_ID`); never in the tab list. */
export const QUICK_CHAT_TAB_ID = "quick"

const tabsKey = (orgId: string) => `maple-chat-tabs:${orgId}`
const sheetTabKey = (orgId: string) => `maple-chat-sheet-tab:${orgId}`

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

export const freshTabs = (nowMs: number): TabsState => ({
	tabs: [{ id: DEFAULT_TAB_ID, title: "New Chat", createdAt: nowMs, updatedAt: nowMs }],
	activeTabId: DEFAULT_TAB_ID,
})

const getItem = (key: string) =>
	Effect.orElseSucceed(
		Effect.try(() => localStorage.getItem(key)),
		() => null,
	)
const setItem = (key: string, value: string) =>
	Effect.ignore(Effect.try(() => localStorage.setItem(key, value)))

/** `loadState`: the stored tabs (older ones lack `updatedAt`), else one fresh "New Chat". */
export const readTabs = (orgId: string, nowMs: number) =>
	Effect.map(getItem(tabsKey(orgId)), (raw) =>
		Option.getOrElse(
			Option.map(
				Option.filter(
					Option.flatMap(Option.fromNullishOr(raw), decodeStoredTabs),
					(stored) => stored.tabs.length > 0 && stored.activeTabId !== "",
				),
				(stored): TabsState => ({
					activeTabId: stored.activeTabId,
					tabs: stored.tabs.map((tab) => ({ ...tab, updatedAt: tab.updatedAt ?? tab.createdAt })),
				}),
			),
			() => freshTabs(nowMs),
		),
	)

export const writeTabs = (orgId: string, state: TabsState) => setItem(tabsKey(orgId), encodeTabs(state))

/** `ensureStoredTab`: registers (and activates) a tab without mounting the chat page. */
export const ensureStoredTab = (orgId: string, id: string, title: string, nowMs: number) =>
	Effect.flatMap(readTabs(orgId, nowMs), (state) =>
		writeTabs(
			orgId,
			state.tabs.some((tab) => tab.id === id)
				? { ...state, activeTabId: id }
				: {
						tabs: [...state.tabs, { id, title, createdAt: nowMs, updatedAt: nowMs }],
						activeTabId: id,
					},
		),
	)

/** `createTab` outside the page: appended and made active. */
export const appendStoredTab = (orgId: string, id: string, nowMs: number) =>
	Effect.flatMap(readTabs(orgId, nowMs), (state) =>
		writeTabs(orgId, {
			tabs: [...state.tabs, { id, title: "New Chat", createdAt: nowMs, updatedAt: nowMs }],
			activeTabId: id,
		}),
	)

/** `renameTab` outside the page; an id not in the list (the quick thread) changes nothing but is saved. */
export const renameStoredTab = (orgId: string, id: string, title: string, nowMs: number) =>
	Effect.flatMap(readTabs(orgId, nowMs), (state) =>
		writeTabs(orgId, {
			...state,
			tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, title, updatedAt: nowMs } : tab)),
		}),
	)

/** `loadSheetTab`: the thread the sheet last showed, if it is still a tab; else the quick thread. */
export const loadSheetTab = (orgId: string, nowMs: number) =>
	Effect.gen(function* () {
		const stored = yield* getItem(sheetTabKey(orgId))
		if (stored === null || stored === QUICK_CHAT_TAB_ID) return QUICK_CHAT_TAB_ID
		const state = yield* readTabs(orgId, nowMs)
		return state.tabs.some((tab) => tab.id === stored) ? stored : QUICK_CHAT_TAB_ID
	})

export const saveSheetTab = (orgId: string, id: string) => setItem(sheetTabKey(orgId), id)
