import { Clock, Duration, Effect, Layer, Schema } from "effect"
import { recordCached, withCache } from "../../data/cached"
import type { LoadFailure } from "../../data/local-query"
import { logsKey, optionsFromCached, pagesFromCached, pagesToCached, patternsFromCached, patternsKey, patternsToCached, servicesKey, severitiesKey } from "./cache"
import { fetchLogsPage, fetchPatterns, fetchServices, fetchSeverities, type LogCursor, nextCursor } from "./fetch"
import { LogsDefinition } from "./definition"
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

export const ReadClock = LogsDefinition.makeCommand("ReadLogsClock", {
	messages: [Message.CompletedReadClock],
	handler: function* () {
		return () => Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs }))
	},
})

export const ReadRefreshClock = LogsDefinition.makeCommand("ReadLogsRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	handler: function* () {
		return () => Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs }))
	},
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
export const FetchLogs = LogsDefinition.makeCommand("FetchLocalLogs", {
	args: { ...RequestArgs, pageCount: Schema.Number, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchLogs, Message.FailedFetchLogs, Message.FoundCachedLogs],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, search, startTime, endTime, apiBase, pageCount, readsCache }) =>
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
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchLogs({ key, failure }))))
	},
})

export const FetchNextPage = LogsDefinition.makeCommand("FetchNextLocalLogsPage", {
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
	handler: function* () {
		return (args) =>
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
			)
	},
})

export const FetchPatterns = LogsDefinition.makeCommand("FetchLocalLogPatterns", {
	args: { ...RequestArgs, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchPatterns, Message.FailedFetchPatterns, Message.FoundCachedPatterns],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, search, startTime, endTime, apiBase, readsCache }) =>
			withCache({
				key: patternsKey({ search, startTime, endTime }),
				readsCache,
				fromCached: patternsFromCached,
				toCached: patternsToCached,
				fetch: fetchPatterns(filtersFrom(search), { startTime, endTime }, apiBase),
				found: (cached) => Message.FoundCachedPatterns({ key, cached }),
				succeeded: (data, fetchedAtMs) => Message.SucceededFetchPatterns({ key, data, fetchedAtMs }),
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchPatterns({ key, failure }))))
	},
})

/** The facets' own `staleTime`. */
const FACET_STALE_MS = 60_000

export const FetchServices = LogsDefinition.makeCommand("FetchLocalLogServices", {
	args: { ...RequestArgs, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchServices, Message.FailedFetchServices, Message.FoundCachedServices],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, search, startTime, endTime, apiBase, readsCache }) =>
			withCache({
				key: servicesKey({ search, startTime, endTime }),
				readsCache,
				fromCached: optionsFromCached,
				staleMs: FACET_STALE_MS,
				toCached: (options) => options,
				fetch: fetchServices(filtersFrom(search), { startTime, endTime }, apiBase),
				found: (cached) => Message.FoundCachedServices({ key, cached }),
				succeeded: (options, fetchedAtMs) => Message.SucceededFetchServices({ key, options, fetchedAtMs }),
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchServices({ key, failure }))))
	},
})

export const FetchSeverities = LogsDefinition.makeCommand("FetchLocalLogSeverities", {
	args: { ...RequestArgs, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchSeverities, Message.FailedFetchSeverities, Message.FoundCachedSeverities],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, search, startTime, endTime, apiBase, readsCache }) =>
			withCache({
				key: severitiesKey({ search, startTime, endTime }),
				readsCache,
				fromCached: optionsFromCached,
				staleMs: FACET_STALE_MS,
				toCached: (options) => options,
				fetch: fetchSeverities(filtersFrom(search), { startTime, endTime }, apiBase),
				found: (cached) => Message.FoundCachedSeverities({ key, cached }),
				succeeded: (options, fetchedAtMs) => Message.SucceededFetchSeverities({ key, options, fetchedAtMs }),
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchSeverities({ key, failure }))))
	},
})

/** The clipboard write of a chip's `key=value`; a refused clipboard is not an error the row shows. */
export const CopyChip = LogsDefinition.makeCommand("CopyLocalLogChip", {
	args: { text: Schema.String },
	messages: [Message.CompletedCopyChip],
	handler: function* () {
		return ({ text }) =>
			Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
				Effect.ignore,
				Effect.as(Message.CompletedCopyChip()),
			)
	},
})

/** `ToolbarSearch`'s 300 ms pause before a typed search commits. */
export const WaitSearchDebounce = LogsDefinition.makeCommand("WaitLogsSearchDebounce", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	handler: function* () {
		return ({ version }) => Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ version }))
	},
})

/** The mode toggle's press, brought back as a page Message so the update can read the hash. */
export const RelayModeChoice = LogsDefinition.makeCommand("RelayLogsModeChoice", {
	args: { value: Schema.String },
	messages: [Message.ChoseMode],
	handler: function* () {
		return ({ value }) => Effect.succeed(Message.ChoseMode({ value }))
	},
})

export type LogsCommand =
	| ReturnType<typeof ReadClock>
	| ReturnType<typeof ReadRefreshClock>
	| ReturnType<typeof FetchLogs>
	| ReturnType<typeof FetchNextPage>
	| ReturnType<typeof FetchPatterns>
	| ReturnType<typeof FetchServices>
	| ReturnType<typeof FetchSeverities>
	| ReturnType<typeof CopyChip>
	| ReturnType<typeof WaitSearchDebounce>
	| ReturnType<typeof RelayModeChoice>

export const CommandsLayer = Layer.mergeAll(
	ReadClock.layer,
	ReadRefreshClock.layer,
	FetchLogs.layer,
	FetchNextPage.layer,
	FetchPatterns.layer,
	FetchServices.layer,
	FetchSeverities.layer,
	CopyChip.layer,
	WaitSearchDebounce.layer,
	RelayModeChoice.layer,
)
