import { getUsersFacets, listUsers, USERS_SEARCH_MAX_LENGTH } from "@maple/web-data/warehouse/users"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { IdleTtl } from "../../../data/idle-ttl"
import { readThrough } from "../../../data/read-cache"
import { TimeWindow } from "../../../data/time-range"
import { resolveUsersWindow } from "../window"
import { UsersSearch } from "../../../route/search"
import { loadSignalPresences } from "../../kit/signal-presence"
import { Message, RequestMode } from "./message"
import { UsersFacetsData, UsersPage, type Search } from "./model"

/** Users the directory reads in one go. */
export const USERS_LIMIT = 200

/** The namespaces in effect: the org-global pin wins over the rail's picks (as on traces). */
export const namespaceScope = (search: Search, pinnedNamespace: string | null): ReadonlyArray<string> =>
	pinnedNamespace !== null ? [pinnedNamespace] : (search.namespaces ?? [])

/** The facets' and the summary's scope: the org pin only, never the rail's picks. */
export const pinScope = (pinnedNamespace: string | null): ReadonlyArray<string> =>
	pinnedNamespace === null ? [] : [pinnedNamespace]

/** The facets' inputs: the window and the pin only, so a rail pick never refetches the facets. */
export const facetsInputs = (window: TimeWindow, pinnedNamespace: string | null) => ({
	startTime: window.startTime,
	endTime: window.endTime,
	namespaces: pinScope(pinnedNamespace),
})

/** The typed search as the API takes it: trimmed, cut to its 200-character cap, absent when blank. */
const searchText = (q: string | undefined): string | undefined => {
	const text = (q ?? "").trim().slice(0, USERS_SEARCH_MAX_LENGTH).trim()
	return text === "" ? undefined : text
}

/** The list's inputs: the window, the namespace scope, the search, the toggles and the group picks. */
export const listInputs = (search: Search, window: TimeWindow, pinnedNamespace: string | null) => ({
	startTime: window.startTime,
	endTime: window.endTime,
	namespaces: namespaceScope(search, pinnedNamespace),
	search: searchText(search.q),
	hasErrors: search.hasErrors === true ? true : undefined,
	hasReplay: search.hasReplay === true ? true : undefined,
	groups: search.groups,
	limit: USERS_LIMIT,
})

export const ResolveWindow = Command.define("ResolveUsersWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveUsersWindow(
					{ startTime, endTime, preset, snap: mode === "Load", timeZone },
					nowMs,
				),
				nowMs,
				mode,
			}),
		),
})

const FetchArgs = {
	key: Schema.String,
	search: UsersSearch,
	window: TimeWindow,
	pinnedNamespace: Schema.NullOr(Schema.String),
	refresh: Schema.Boolean,
}

export const FetchUsers = Command.define("FetchUsers", {
	args: FetchArgs,
	messages: [Message.CompletedFetchUsers],
	execute: ({ key, refresh, search, window, pinnedNamespace }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.listUsers, schema: UsersPage },
			Effect.map(
				listUsers({ data: listInputs(search, window, pinnedNamespace) }),
				(response): UsersPage => ({ users: response.users }),
			),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchUsers({ key, result })),
		),
})

export const FetchFacets = Command.define("FetchUsersFacets", {
	args: FetchArgs,
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, refresh, window, pinnedNamespace }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.usersFacets, schema: UsersFacetsData },
			Effect.map(
				getUsersFacets({ data: facetsInputs(window, pinnedNamespace) }),
				(response): UsersFacetsData => ({
					namespaces: response.namespaces,
					groups: response.groups,
					withErrors: response.withErrors,
					withReplay: response.withReplay,
					identified: response.identified,
					activeToday: response.activeToday,
					anonymousVisitors: response.anonymousVisitors,
				}),
			),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

export const LoadSignalPresence = Command.define("LoadUsersSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})

/** The search box's 300 ms debounce. */
export const DebounceQuery = Command.define("DebounceUsersQuery", {
	args: { generation: Schema.Number },
	messages: [Message.CompletedQueryDebounce],
	execute: ({ generation }) =>
		Effect.as(Effect.sleep(Duration.millis(300)), Message.CompletedQueryDebounce({ generation })),
})

export const CompleteReloadSpin = Command.define("CompleteUsersReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
