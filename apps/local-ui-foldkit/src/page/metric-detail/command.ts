import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { MetricEntry } from "../metrics/catalog"
import { fetchMetricBreakdown, fetchMetricEntry, fetchMetricTimeseries } from "./fetch"
import { Message } from "./message"

const Window = { key: Schema.String, startTime: Schema.String, endTime: Schema.String, apiBase: Schema.String }

export const ReadClock = Command.define("ReadMetricDetailClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadRefreshClock = Command.define("ReadMetricDetailRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs })),
})

export const FetchEntry = Command.define("FetchLocalMetricEntry", {
	args: { ...Window, metricName: Schema.String },
	messages: [Message.SucceededFetchEntry, Message.FailedFetchEntry],
	execute: ({ key, metricName, startTime, endTime, apiBase }) =>
		Effect.gen(function* () {
			const entry = yield* fetchMetricEntry(metricName, { startTime, endTime }, apiBase)
			const fetchedAtMs = yield* Clock.currentTimeMillis
			return Message.SucceededFetchEntry({ key, entry, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchEntry({ key, failure })))),
})

export const FetchTimeseries = Command.define("FetchLocalMetricTimeseries", {
	args: { ...Window, entry: MetricEntry, bucketSeconds: Schema.Number },
	messages: [Message.SucceededFetchTimeseries, Message.FailedFetchTimeseries],
	execute: ({ key, entry, bucketSeconds, startTime, endTime, apiBase }) =>
		fetchMetricTimeseries(entry, { startTime, endTime }, bucketSeconds, apiBase).pipe(
			Effect.map((points) => Message.SucceededFetchTimeseries({ key, points })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchTimeseries({ key, failure }))),
		),
})

export const FetchBreakdown = Command.define("FetchLocalMetricBreakdown", {
	args: { ...Window, entry: MetricEntry },
	messages: [Message.SucceededFetchBreakdown, Message.FailedFetchBreakdown],
	execute: ({ key, entry, startTime, endTime, apiBase }) =>
		fetchMetricBreakdown(entry, { startTime, endTime }, apiBase).pipe(
			Effect.map((rows) => Message.SucceededFetchBreakdown({ key, rows })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchBreakdown({ key, failure }))),
		),
})
