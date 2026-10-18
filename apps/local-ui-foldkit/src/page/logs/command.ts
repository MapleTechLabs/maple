import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import type { LoadFailure } from "../../data/local-query"
import { fetchLogsPage, fetchPatterns, fetchServices, fetchSeverities, type LogCursor, nextCursor } from "./fetch"
import { filtersOf } from "./filters"
import { Message } from "./message"
import type { LocalLog } from "./model"

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

/** React Query refetches an infinite query page by page, each cursor from the page before. */
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

export const FetchLogs = Command.define("FetchLocalLogs", {
	args: { ...RequestArgs, pageCount: Schema.Number },
	messages: [Message.SucceededFetchLogs, Message.FailedFetchLogs],
	execute: ({ key, search, startTime, endTime, apiBase, pageCount }) =>
		Effect.gen(function* () {
			const filters = filtersFrom(search)
			const pages = yield* fetchPages(
				(cursor) => fetchLogsPage(filters, { startTime, endTime }, cursor, apiBase),
				pageCount,
				undefined,
				[],
			)
			const last = pages[pages.length - 1] ?? []
			const fetchedAtMs = yield* Clock.currentTimeMillis
			return Message.SucceededFetchLogs({ key, data: { pages, hasNextPage: nextCursor(last) !== undefined }, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchLogs({ key, failure })))),
})

export const FetchNextPage = Command.define("FetchNextLocalLogsPage", {
	args: {
		...RequestArgs,
		cursorTimestamp: Schema.String,
		cursorServiceName: Schema.String,
		cursorTraceId: Schema.String,
		cursorSpanId: Schema.String,
		cursorRecordIdentity: Schema.String,
	},
	messages: [Message.SucceededFetchNextPage, Message.FailedFetchNextPage],
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
			Effect.map((page) => Message.SucceededFetchNextPage({ key: args.key, page })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchNextPage({ key: args.key, failure }))),
		),
})

export const FetchPatterns = Command.define("FetchLocalLogPatterns", {
	args: RequestArgs,
	messages: [Message.SucceededFetchPatterns, Message.FailedFetchPatterns],
	execute: ({ key, search, startTime, endTime, apiBase }) =>
		Effect.gen(function* () {
			const data = yield* fetchPatterns(filtersFrom(search), { startTime, endTime }, apiBase)
			const fetchedAtMs = yield* Clock.currentTimeMillis
			return Message.SucceededFetchPatterns({ key, data, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchPatterns({ key, failure })))),
})

export const FetchServices = Command.define("FetchLocalLogServices", {
	args: RequestArgs,
	messages: [Message.SucceededFetchServices, Message.FailedFetchServices],
	execute: ({ key, search, startTime, endTime, apiBase }) =>
		fetchServices(filtersFrom(search), { startTime, endTime }, apiBase).pipe(
			Effect.map((options) => Message.SucceededFetchServices({ key, options })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchServices({ key, failure }))),
		),
})

export const FetchSeverities = Command.define("FetchLocalLogSeverities", {
	args: RequestArgs,
	messages: [Message.SucceededFetchSeverities, Message.FailedFetchSeverities],
	execute: ({ key, search, startTime, endTime, apiBase }) =>
		fetchSeverities(filtersFrom(search), { startTime, endTime }, apiBase).pipe(
			Effect.map((options) => Message.SucceededFetchSeverities({ key, options })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchSeverities({ key, failure }))),
		),
})

/** `useCopy`'s write of a chip's `key=value`; a refused clipboard is not an error the row shows. */
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
