import { listFromCached, sparklinesFromCached, sparklinesToCached, summaryFromCached } from "./cache"
import { withCache } from "../../data/cached"
import { Clock, Duration, Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { fetchMetricsList, fetchMetricsSummary, fetchSparklines } from "./fetch"
import { Message } from "./message"
import { ListRequest, SparklinesRequest, SummaryRequest } from "./requests"


export const ReadClock = Command.define("ReadMetricsClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadRefreshClock = Command.define("ReadMetricsRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs })),
})


export const FetchList = Command.define("FetchLocalMetricsList", {
	args: { ...ListRequest.fields, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchList, Message.FailedFetchList, Message.FoundCachedList],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ readsCache, ...request }) =>
		withCache({
			key: ["local", "metrics", "list", request.type ?? null, request.search ?? null, `${request.startTime}/${request.endTime}`],
			readsCache,
			fromCached: listFromCached,
			toCached: (data) => data,
			fetch: fetchMetricsList({ type: request.type, search: request.search }, request, request.apiBase),
			found: (cached) => Message.FoundCachedList({ request, cached }),
			succeeded: (data, fetchedAtMs) => Message.SucceededFetchList({ key: request.key, data, fetchedAtMs }),
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchList({ key: request.key, failure })))),
})

export const FetchSummary = Command.define("FetchLocalMetricsSummary", {
	args: { ...SummaryRequest.fields, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchSummary, Message.FailedFetchSummary, Message.FoundCachedSummary],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ readsCache, ...request }) =>
		withCache({
			key: ["local", "metrics", "summary", request.service ?? null, `${request.startTime}/${request.endTime}`],
			readsCache,
			fromCached: summaryFromCached,
			toCached: (rows) => rows,
			fetch: fetchMetricsSummary(request.service, request, request.apiBase),
			found: (cached) => Message.FoundCachedSummary({ request, cached }),
			succeeded: (rows, fetchedAtMs) => Message.SucceededFetchSummary({ key: request.key, rows, fetchedAtMs }),
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchSummary({ key: request.key, failure })))),
})

export const FetchSparklines = Command.define("FetchLocalMetricsSparklines", {
	args: { ...SparklinesRequest.fields, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchSparklines, Message.FailedFetchSparklines, Message.FoundCachedSparklines],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ readsCache, ...request }) =>
		withCache({
			key: ["local", "metrics", "sparklines", request.groups, request.bucketSeconds, `${request.startTime}/${request.endTime}`],
			readsCache,
			fromCached: sparklinesFromCached,
			toCached: sparklinesToCached,
			fetch: fetchSparklines(request.groups, request, request.bucketSeconds, request.apiBase),
			found: (cached) => Message.FoundCachedSparklines({ request, cached }),
			succeeded: (sparklines, fetchedAtMs) => Message.SucceededFetchSparklines({ key: request.key, sparklines, fetchedAtMs }),
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchSparklines({ key: request.key, failure })))),
})

export const WaitSearchDebounce = Command.define("WaitMetricsSearchDebounce", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ version }) => Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ version })),
})

/** The grid's `ResizeObserver` (a callback ref in React): its width picks the column count. */
export const MeasureGrid = Mount.defineStream("MeasureLocalMetricsGrid", {
	messages: [Message.MeasuredGrid],
	execute: ({ element }) =>
		Stream.callback<typeof Message.MeasuredGrid.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const observer = new ResizeObserver((entries) =>
						Queue.offerUnsafe(queue, Message.MeasuredGrid({ width: entries[0]?.contentRect.width ?? 0 })),
					)
					observer.observe(element)
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
