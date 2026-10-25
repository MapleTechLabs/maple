import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { recordCached, withCache } from "../../data/cached"
import type { LoadFailure } from "../../data/local-query"
import { logsKey, optionsFromCached, pagesFromCached, pagesToCached, patternsFromCached, patternsKey, patternsToCached, servicesKey, severitiesKey } from "./cache"
import { fetchLogsPage, fetchPatterns, fetchServices, fetchSeverities, type LogCursor, nextCursor } from "./fetch"
import { filtersOf } from "./filters"
import { Message } from "./message"
import { LocalLog } from "./model"

/** What one request reads: the hash query (filters), the window and the server. */
const RequestArgs = {
	key: Schema.String,
	search: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	apiBase: Schema.String,
}

const filtersFrom = (search: string) => filtersOf(new URLSearchParams(search))

export const ReadClock = Command.define("ReadLogsClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadRefreshClock = Command.define("ReadLogsRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs })),
})

/** A paged query refetches page by page, each cursor from the page before. */
const fetchPages = <R>(
	run: (cursor: LogCursor | undefined) => Effect.Effect<ReadonlyArray<LocalLog>, LoadFailure, R>,
	remaining: number,
	cursor: LogCursor | undefined,
	loaded: ReadonlyArray<ReadonlyArray<LocalLog>>,
): Effect.Effect<ReadonlyArray<ReadonlyArray<LocalLog>>, LoadFailure, R> =>
	Effect.flatMap(run(cursor), (page) => {
		const pages = [...loaded, page]
		const next = nextCursor(page)
		return remaining <= 1 || next === undefined ? Effect.succeed(pages) : fetchPages(run, remaining - 1, next, pages)
	})

/** `readsCache`: a key the page has no rows for yet opens on its cached result first. */
export const FetchLogs = Command.define("FetchLocalLogs", {
	args: { ...RequestArgs, pageCount: Schema.Number, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchLogs, Message.FailedFetchLogs, Message.FoundCachedLogs],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ key, search, startTime, endTime, apiBase, pageCount, readsCache }) =>
		withCache({
			key: logsKey({ search, startTime, endTime }),
			readsCache,
			fromCached: pagesFromCached,
			toCached: pagesToCached,
			fetch: Effect.map(
				fetchPages((cursor) => fetchLogsPage(filtersFrom(search), { startTime, endTime }, cursor, apiBase), pageCount, undefined, []),
				(pages) => ({ pages, hasNextPage: nextCursor(pages[pages.length - 1] ?? []) !== undefined }),
			),
			found: (cached) => Message.FoundCachedLogs({ key, cached }),
			succeeded: (data, fetchedAtMs) => Message.SucceededFetchLogs({ key, data, fetchedAtMs }),
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchLogs({ key, failure })))),
})

export const FetchNextPage = Command.define("FetchNextLocalLogsPage", {
	args: {
		...RequestArgs,
		/** The list generation the page extends; a reload retires it. */
		generation: Schema.Number,
		cursorTimestamp: Schema.String,
		cursorServiceName: Schema.String,
		cursorTraceId: Schema.String,
		cursorSpanId: Schema.String,
		cursorRecordIdentity: Schema.String,
		/** The pages loaded so far; the cache keeps them with the new one. */
		pages: Schema.Array(Schema.Array(LocalLog)),
	},
	messages: [Message.SucceededFetchNextPage, Message.FailedFetchNextPage],
	interrupt: { keyFields: ["key", "generation"], toKey: ({ key, generation }) => `${key}#${generation}` },
	execute: (args) =>
		fetchLogsPage(
			filtersFrom(args.search),
			{ startTime: args.startTime, endTime: args.endTime },
			{
				timestamp: args.cursorTimestamp,
				serviceName: args.cursorServiceName,
				traceId: args.cursorTraceId,
				spanId: args.cursorSpanId,
				recordIdentity: args.cursorRecordIdentity,
			},
			args.apiBase,
		).pipe(
			// `fetchNextPage` updates the cached query too, so a reload opens on every page loaded.
			Effect.tap((page) =>
				Effect.flatMap(Clock.currentTimeMillis, (atMs) =>
					recordCached(logsKey(args), pagesToCached({ pages: [...args.pages, page] }), atMs),
				),
			),
			Effect.map((page) => Message.SucceededFetchNextPage({ key: args.key, generation: args.generation, page })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchNextPage({ key: args.key, generation: args.generation, failure }))),
		),
})

export const FetchPatterns = Command.define("FetchLocalLogPatterns", {
	args: { ...RequestArgs, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchPatterns, Message.FailedFetchPatterns, Message.FoundCachedPatterns],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ key, search, startTime, endTime, apiBase, readsCache }) =>
		withCache({
			key: patternsKey({ search, startTime, endTime }),
			readsCache,
			fromCached: patternsFromCached,
			toCached: patternsToCached,
			fetch: fetchPatterns(filtersFrom(search), { startTime, endTime }, apiBase),
			found: (cached) => Message.FoundCachedPatterns({ key, cached }),
			succeeded: (data, fetchedAtMs) => Message.SucceededFetchPatterns({ key, data, fetchedAtMs }),
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchPatterns({ key, failure })))),
})

/** The facets' own `staleTime`. */
const FACET_STALE_MS = 60_000

export const FetchServices = Command.define("FetchLocalLogServices", {
	args: { ...RequestArgs, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchServices, Message.FailedFetchServices, Message.FoundCachedServices],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ key, search, startTime, endTime, apiBase, readsCache }) =>
		withCache({
			key: servicesKey({ search, startTime, endTime }),
			readsCache,
			fromCached: optionsFromCached,
			staleMs: FACET_STALE_MS,
			toCached: (options) => options,
			fetch: fetchServices(filtersFrom(search), { startTime, endTime }, apiBase),
			found: (cached) => Message.FoundCachedServices({ key, cached }),
			succeeded: (options, fetchedAtMs) => Message.SucceededFetchServices({ key, options, fetchedAtMs }),
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchServices({ key, failure })))),
})

export const FetchSeverities = Command.define("FetchLocalLogSeverities", {
	args: { ...RequestArgs, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchSeverities, Message.FailedFetchSeverities, Message.FoundCachedSeverities],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ key, search, startTime, endTime, apiBase, readsCache }) =>
		withCache({
			key: severitiesKey({ search, startTime, endTime }),
			readsCache,
			fromCached: optionsFromCached,
			staleMs: FACET_STALE_MS,
			toCached: (options) => options,
			fetch: fetchSeverities(filtersFrom(search), { startTime, endTime }, apiBase),
			found: (cached) => Message.FoundCachedSeverities({ key, cached }),
			succeeded: (options, fetchedAtMs) => Message.SucceededFetchSeverities({ key, options, fetchedAtMs }),
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchSeverities({ key, failure })))),
})

/** The clipboard write of a chip's `key=value`; a refused clipboard is not an error the row shows. */
export const CopyChip = Command.define("CopyLocalLogChip", {
	args: { text: Schema.String },
	messages: [Message.CompletedCopyChip],
	execute: ({ text }) =>
		Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
			Effect.ignore,
			Effect.as(Message.CompletedCopyChip()),
		),
})

/** `ToolbarSearch`'s 300 ms pause before a typed search commits. */
export const WaitSearchDebounce = Command.define("WaitLogsSearchDebounce", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ version }) => Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ version })),
})
