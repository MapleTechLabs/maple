import { Clock, Duration, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { readCached, recordCached } from "../../data/cached"
import type { LoadFailure } from "../../data/local-query"
import { facetsFromCached, facetsKey, facetsToCached, pagesFromCached, pagesToCached, tracesKey } from "./cache"
import { fetchTraceFacets } from "./fetch-facets"
import { fetchTracePage, nextCursor, type TraceCursor } from "./fetch-traces"
import { filtersOf } from "./filters"
import { Message } from "./message"
import { TraceRow } from "./model"

/** What one list or facets request reads: the hash query (filters), the window and the server. */
const RequestArgs = {
	key: Schema.String,
	search: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	apiBase: Schema.String,
}

/** The time window's initial anchor and the clock for relative times. */
export const ReadClock = Command.define("ReadTracesClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadRefreshClock = Command.define("ReadTracesRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs })),
})

/** A refetch goes page by page, each cursor from the page before. */
const fetchPages = <R>(
	run: (cursor: TraceCursor | undefined) => Effect.Effect<ReadonlyArray<TraceRow>, LoadFailure, R>,
	remaining: number,
	cursor: TraceCursor | undefined,
	loaded: ReadonlyArray<ReadonlyArray<TraceRow>>,
): Effect.Effect<ReadonlyArray<ReadonlyArray<TraceRow>>, LoadFailure, R> =>
	Effect.flatMap(run(cursor), (page) => {
		const pages = [...loaded, page]
		const next = nextCursor(page)
		return remaining <= 1 || next === undefined ? Effect.succeed(pages) : fetchPages(run, remaining - 1, next, pages)
	})

/** `readsCache`: a key the page has no rows for yet opens on its cached result first. */
export const FetchTraces = Command.define("FetchLocalTraces", {
	args: { ...RequestArgs, pageCount: Schema.Number, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchTraces, Message.FailedFetchTraces, Message.FoundCachedTraces],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ key, search, startTime, endTime, apiBase, pageCount, readsCache }) =>
		Effect.gen(function* () {
			const cacheKey = tracesKey({ search, startTime, endTime })
			const maybeCached = readsCache ? yield* readCached(cacheKey, pagesFromCached) : Option.none()
			if (Option.isSome(maybeCached)) return Message.FoundCachedTraces({ key, cached: maybeCached.value })
			const filters = filtersOf(new URLSearchParams(search))
			const run = (cursor: TraceCursor | undefined) =>
				fetchTracePage(filters, { startTime, endTime }, cursor, apiBase)
			const pages = yield* fetchPages(run, pageCount, undefined, [])
			const last = pages[pages.length - 1] ?? []
			const fetchedAtMs = yield* Clock.currentTimeMillis
			const data = { pages, hasNextPage: nextCursor(last) !== undefined }
			yield* recordCached(cacheKey, pagesToCached(data), fetchedAtMs)
			return Message.SucceededFetchTraces({ key, data, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchTraces({ key, failure })))),
})

export const FetchNextPage = Command.define("FetchNextLocalTracesPage", {
	args: {
		...RequestArgs,
		/** The list generation the page extends; a reload retires it. */
		generation: Schema.Number,
		cursorTimestamp: Schema.DateTimeUtc,
		cursorTraceId: Schema.String,
		/** The pages loaded so far; the cache keeps them with the new one. */
		pages: Schema.Array(Schema.Array(TraceRow)),
	},
	messages: [Message.SucceededFetchNextPage, Message.FailedFetchNextPage],
	interrupt: { keyFields: ["key", "generation"], toKey: ({ key, generation }) => `${key}#${generation}` },
	execute: ({ key, generation, search, startTime, endTime, apiBase, cursorTimestamp, cursorTraceId, pages }) =>
		fetchTracePage(
			filtersOf(new URLSearchParams(search)),
			{ startTime, endTime },
			{ timestamp: cursorTimestamp, traceId: cursorTraceId },
			apiBase,
		).pipe(
			// `fetchNextPage` updates the cached query too, so a reload opens on every page loaded.
			Effect.tap((page) =>
				Effect.flatMap(Clock.currentTimeMillis, (atMs) =>
					recordCached(tracesKey({ search, startTime, endTime }), pagesToCached({ pages: [...pages, page] }), atMs),
				),
			),
			Effect.map((page) => Message.SucceededFetchNextPage({ key, generation, page })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchNextPage({ key, generation, failure }))),
		),
})

/** How long the facets stay fresh. */
const FACETS_STALE_MS = 15_000

export const FetchFacets = Command.define("FetchLocalTraceFacets", {
	args: { ...RequestArgs, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchFacets, Message.FailedFetchFacets, Message.FoundCachedFacets],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ key, search, startTime, endTime, apiBase, readsCache }) =>
		Effect.gen(function* () {
			const cacheKey = facetsKey({ search, startTime, endTime })
			const maybeCached = readsCache ? yield* readCached(cacheKey, facetsFromCached, FACETS_STALE_MS) : Option.none()
			if (Option.isSome(maybeCached)) return Message.FoundCachedFacets({ key, cached: maybeCached.value })
			const facets = yield* fetchTraceFacets(filtersOf(new URLSearchParams(search)), { startTime, endTime }, apiBase)
			const fetchedAtMs = yield* Clock.currentTimeMillis
			yield* recordCached(cacheKey, facetsToCached(facets), fetchedAtMs)
			return Message.SucceededFetchFacets({ key, facets, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchFacets({ key, failure })))),
})

/** `ToolbarSearch`'s and `RangeFilterSection`'s 300 ms pause before a typed value commits. */
export const DEBOUNCE = Duration.millis(300)

export const WaitSearchDebounce = Command.define("WaitTracesSearchDebounce", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ version }) => Effect.as(Effect.sleep(DEBOUNCE), Message.ElapsedSearchDebounce({ version })),
})

export const WaitDurationDebounce = Command.define("WaitTracesDurationDebounce", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedDurationDebounce],
	execute: ({ version }) => Effect.as(Effect.sleep(DEBOUNCE), Message.ElapsedDurationDebounce({ version })),
})
