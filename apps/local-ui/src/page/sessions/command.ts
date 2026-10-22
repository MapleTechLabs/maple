import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { recordCached, withCache } from "../../data/cached"
import type { LoadFailure } from "../../data/local-query"
import { facetsFromCached, facetsKey, pagesFromCached, pagesToCached, sessionsKey } from "./cache"
import { fetchSessionFacets, fetchSessionPage, filtersOf, nextCursor, type SessionCursor } from "./fetch"
import { Message } from "./message"
import { SessionRow } from "./model"

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

/** A refetch goes page by page, each cursor from the page before. */
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

/** `readsCache`: a key the page has no rows for yet opens on its cached result first. */
export const FetchSessions = Command.define("FetchLocalSessions", {
	args: { ...RequestArgs, pageCount: Schema.Number, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchSessions, Message.FailedFetchSessions, Message.FoundCachedSessions],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ key, search, startTime, endTime, apiBase, pageCount, readsCache }) => {
		const filters = filtersOf(new URLSearchParams(search))
		const run = (cursor: SessionCursor | undefined) => fetchSessionPage(filters, { startTime, endTime }, cursor, apiBase)
		return withCache({
			key: sessionsKey({ search, startTime, endTime }),
			readsCache,
			fromCached: pagesFromCached,
			toCached: pagesToCached,
			fetch: Effect.map(fetchPages(run, pageCount, undefined, []), (pages) => ({
				pages,
				hasNextPage: nextCursor(pages[pages.length - 1] ?? []) !== undefined,
			})),
			found: (cached) => Message.FoundCachedSessions({ key, cached }),
			succeeded: (data, fetchedAtMs) => Message.SucceededFetchSessions({ key, data, fetchedAtMs }),
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchSessions({ key, failure }))))
	},
})

export const FetchNextPage = Command.define("FetchNextLocalSessionsPage", {
	args: {
		...RequestArgs,
		/** The list generation the page extends; a reload retires it. */
		generation: Schema.Number,
		cursorStartTime: Schema.DateTimeUtc,
		cursorSessionId: Schema.String,
		/** The pages loaded so far; the cache keeps them with the new one. */
		pages: Schema.Array(Schema.Array(SessionRow)),
	},
	messages: [Message.SucceededFetchNextPage, Message.FailedFetchNextPage],
	interrupt: { keyFields: ["key", "generation"], toKey: ({ key, generation }) => `${key}#${generation}` },
	execute: ({ key, generation, search, startTime, endTime, apiBase, cursorStartTime, cursorSessionId, pages }) =>
		fetchSessionPage(
			filtersOf(new URLSearchParams(search)),
			{ startTime, endTime },
			{ startTime: cursorStartTime, sessionId: cursorSessionId },
			apiBase,
		).pipe(
			// `fetchNextPage` updates the cached query too, so a reload opens on every page loaded.
			Effect.tap((page) =>
				Effect.flatMap(Clock.currentTimeMillis, (atMs) =>
					recordCached(sessionsKey({ search, startTime, endTime }), pagesToCached({ pages: [...pages, page] }), atMs),
				),
			),
			Effect.map((page) => Message.SucceededFetchNextPage({ key, generation, page })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchNextPage({ key, generation, failure }))),
		),
})

/** How long the facets stay fresh. */
const FACETS_STALE_MS = 30_000

export const FetchFacets = Command.define("FetchLocalSessionFacets", {
	args: { ...RequestArgs, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchFacets, Message.FailedFetchFacets, Message.FoundCachedFacets],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ key, search, startTime, endTime, apiBase, readsCache }) =>
		withCache({
			key: facetsKey({ search, startTime, endTime }),
			readsCache,
			fromCached: facetsFromCached,
			staleMs: FACETS_STALE_MS,
			toCached: (facets) => facets,
			fetch: fetchSessionFacets(filtersOf(new URLSearchParams(search)), { startTime, endTime }, apiBase),
			found: (cached) => Message.FoundCachedFacets({ key, cached }),
			succeeded: (facets, fetchedAtMs) => Message.SucceededFetchFacets({ key, facets, fetchedAtMs }),
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchFacets({ key, failure })))),
})

/** `ToolbarSearch`'s 300 ms pause before a typed value commits. */
export const WaitSearchDebounce = Command.define("WaitSessionsSearchDebounce", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ version }) => Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ version })),
})
