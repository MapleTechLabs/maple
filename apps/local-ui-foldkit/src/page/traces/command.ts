import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import type { LoadFailure } from "../../data/local-query"
import { fetchTraceFacets } from "./fetch-facets"
import { fetchTracePage, nextCursor, type TraceCursor } from "./fetch-traces"
import { filtersOf } from "./filters"
import { Message } from "./message"
import type { TraceRow } from "./model"

/** What one list or facets request reads: the hash query (filters), the window and the server. */
const RequestArgs = {
	key: Schema.String,
	search: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	apiBase: Schema.String,
}

/** `useTimeWindow`'s initial anchor and the clock for relative times. */
export const ReadClock = Command.define("ReadTracesClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadRefreshClock = Command.define("ReadTracesRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs })),
})

/** React Query refetches an infinite query page by page, each cursor from the page before. */
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

export const FetchTraces = Command.define("FetchLocalTraces", {
	args: { ...RequestArgs, pageCount: Schema.Number },
	messages: [Message.SucceededFetchTraces, Message.FailedFetchTraces],
	execute: ({ key, search, startTime, endTime, apiBase, pageCount }) =>
		Effect.gen(function* () {
			const filters = filtersOf(new URLSearchParams(search))
			const run = (cursor: TraceCursor | undefined) =>
				fetchTracePage(filters, { startTime, endTime }, cursor, apiBase)
			const pages = yield* fetchPages(run, pageCount, undefined, [])
			const last = pages[pages.length - 1] ?? []
			const fetchedAtMs = yield* Clock.currentTimeMillis
			return Message.SucceededFetchTraces({ key, data: { pages, hasNextPage: nextCursor(last) !== undefined }, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchTraces({ key, failure })))),
})

export const FetchNextPage = Command.define("FetchNextLocalTracesPage", {
	args: { ...RequestArgs, cursorTimestamp: Schema.DateTimeUtc, cursorTraceId: Schema.String },
	messages: [Message.SucceededFetchNextPage, Message.FailedFetchNextPage],
	execute: ({ key, search, startTime, endTime, apiBase, cursorTimestamp, cursorTraceId }) =>
		fetchTracePage(
			filtersOf(new URLSearchParams(search)),
			{ startTime, endTime },
			{ timestamp: cursorTimestamp, traceId: cursorTraceId },
			apiBase,
		).pipe(
			Effect.map((page) => Message.SucceededFetchNextPage({ key, page })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchNextPage({ key, failure }))),
		),
})

export const FetchFacets = Command.define("FetchLocalTraceFacets", {
	args: RequestArgs,
	messages: [Message.SucceededFetchFacets, Message.FailedFetchFacets],
	execute: ({ key, search, startTime, endTime, apiBase }) =>
		fetchTraceFacets(filtersOf(new URLSearchParams(search)), { startTime, endTime }, apiBase).pipe(
			Effect.map((facets) => Message.SucceededFetchFacets({ key, facets })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchFacets({ key, failure }))),
		),
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
