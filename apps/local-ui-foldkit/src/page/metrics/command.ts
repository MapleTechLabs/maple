import { Clock, Duration, Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { fetchMetricsList, fetchMetricsSummary, fetchSparklines, SparklineGroup } from "./fetch"
import { Message } from "./message"

const Window = { startTime: Schema.String, endTime: Schema.String, apiBase: Schema.String }

export const ReadClock = Command.define("ReadMetricsClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadRefreshClock = Command.define("ReadMetricsRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs })),
})

export const FetchList = Command.define("FetchLocalMetricsList", {
	args: { key: Schema.String, type: Schema.optional(Schema.String), search: Schema.optional(Schema.String), ...Window },
	messages: [Message.SucceededFetchList, Message.FailedFetchList],
	execute: ({ key, type, search, startTime, endTime, apiBase }) =>
		Effect.gen(function* () {
			const data = yield* fetchMetricsList({ type, search }, { startTime, endTime }, apiBase)
			const fetchedAtMs = yield* Clock.currentTimeMillis
			return Message.SucceededFetchList({ key, data, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchList({ key, failure })))),
})

export const FetchSummary = Command.define("FetchLocalMetricsSummary", {
	args: { key: Schema.String, service: Schema.optional(Schema.String), ...Window },
	messages: [Message.SucceededFetchSummary, Message.FailedFetchSummary],
	execute: ({ key, service, startTime, endTime, apiBase }) =>
		fetchMetricsSummary(service, { startTime, endTime }, apiBase).pipe(
			Effect.map((rows) => Message.SucceededFetchSummary({ key, rows })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchSummary({ key, failure }))),
		),
})

export const FetchSparklines = Command.define("FetchLocalMetricsSparklines", {
	args: { key: Schema.String, groups: Schema.Array(SparklineGroup), bucketSeconds: Schema.Number, ...Window },
	messages: [Message.SucceededFetchSparklines, Message.FailedFetchSparklines],
	execute: ({ key, groups, bucketSeconds, startTime, endTime, apiBase }) =>
		fetchSparklines(groups, { startTime, endTime }, bucketSeconds, apiBase).pipe(
			Effect.map((sparklines) => Message.SucceededFetchSparklines({ key, sparklines })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchSparklines({ key, failure }))),
		),
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
