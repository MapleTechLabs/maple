import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import type { LoadFailure } from "../../data/local-query"
import { fetchSessionFacets, fetchSessionPage, filtersOf, nextCursor, type SessionCursor } from "./fetch"
import { Message } from "./message"
import type { SessionRow } from "./model"

/** What one list or facets request reads: the hash query (filters), the window and the server. */
const RequestArgs = {
	key: Schema.String,
	search: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	apiBase: Schema.String,
}

export const ReadClock = Command.define("ReadSessionsClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadRefreshClock = Command.define("ReadSessionsRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs })),
})

/** React Query refetches an infinite query page by page, each cursor from the page before. */
const fetchPages = <R>(
	run: (cursor: SessionCursor | undefined) => Effect.Effect<ReadonlyArray<SessionRow>, LoadFailure, R>,
	remaining: number,
	cursor: SessionCursor | undefined,
	loaded: ReadonlyArray<ReadonlyArray<SessionRow>>,
): Effect.Effect<ReadonlyArray<ReadonlyArray<SessionRow>>, LoadFailure, R> =>
	Effect.flatMap(run(cursor), (page) => {
		const pages = [...loaded, page]
		const next = nextCursor(page)
		return remaining <= 1 || next === undefined ? Effect.succeed(pages) : fetchPages(run, remaining - 1, next, pages)
	})

export const FetchSessions = Command.define("FetchLocalSessions", {
	args: { ...RequestArgs, pageCount: Schema.Number },
	messages: [Message.SucceededFetchSessions, Message.FailedFetchSessions],
	execute: ({ key, search, startTime, endTime, apiBase, pageCount }) =>
		Effect.gen(function* () {
			const filters = filtersOf(new URLSearchParams(search))
			const run = (cursor: SessionCursor | undefined) => fetchSessionPage(filters, { startTime, endTime }, cursor, apiBase)
			const pages = yield* fetchPages(run, pageCount, undefined, [])
			const last = pages[pages.length - 1] ?? []
			const fetchedAtMs = yield* Clock.currentTimeMillis
			return Message.SucceededFetchSessions({ key, data: { pages, hasNextPage: nextCursor(last) !== undefined }, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchSessions({ key, failure })))),
})

export const FetchNextPage = Command.define("FetchNextLocalSessionsPage", {
	args: { ...RequestArgs, cursorStartTime: Schema.DateTimeUtc, cursorSessionId: Schema.String },
	messages: [Message.SucceededFetchNextPage, Message.FailedFetchNextPage],
	execute: ({ key, search, startTime, endTime, apiBase, cursorStartTime, cursorSessionId }) =>
		fetchSessionPage(
			filtersOf(new URLSearchParams(search)),
			{ startTime, endTime },
			{ startTime: cursorStartTime, sessionId: cursorSessionId },
			apiBase,
		).pipe(
			Effect.map((page) => Message.SucceededFetchNextPage({ key, page })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchNextPage({ key, failure }))),
		),
})

export const FetchFacets = Command.define("FetchLocalSessionFacets", {
	args: RequestArgs,
	messages: [Message.SucceededFetchFacets, Message.FailedFetchFacets],
	execute: ({ key, search, startTime, endTime, apiBase }) =>
		fetchSessionFacets(filtersOf(new URLSearchParams(search)), { startTime, endTime }, apiBase).pipe(
			Effect.map((facets) => Message.SucceededFetchFacets({ key, facets })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchFacets({ key, failure }))),
		),
})

/** `ToolbarSearch`'s 300 ms pause before a typed value commits. */
export const WaitSearchDebounce = Command.define("WaitSessionsSearchDebounce", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ version }) => Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ version })),
})
