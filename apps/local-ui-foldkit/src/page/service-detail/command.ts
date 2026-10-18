import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { fetchGoldenSignals, fetchOperations, fetchOperationsTimeseries, fetchOverview } from "./fetch"
import { Message } from "./message"

const Window = { key: Schema.String, serviceName: Schema.String, startTime: Schema.String, endTime: Schema.String, apiBase: Schema.String }

export const ReadClock = Command.define("ReadServiceDetailClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadRefreshClock = Command.define("ReadServiceDetailRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs })),
})

export const FetchOverview = Command.define("FetchLocalServiceOverview", {
	args: Window,
	messages: [Message.SucceededFetchOverview, Message.FailedFetchOverview],
	execute: ({ key, serviceName, startTime, endTime, apiBase }) =>
		Effect.gen(function* () {
			const overview = yield* fetchOverview(serviceName, { startTime, endTime }, apiBase)
			const fetchedAtMs = yield* Clock.currentTimeMillis
			return Message.SucceededFetchOverview({ key, overview, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchOverview({ key, failure })))),
})

export const FetchOperations = Command.define("FetchLocalServiceOperations", {
	args: Window,
	messages: [Message.SucceededFetchOperations, Message.FailedFetchOperations],
	execute: ({ key, serviceName, startTime, endTime, apiBase }) =>
		fetchOperations(serviceName, { startTime, endTime }, apiBase).pipe(
			Effect.map((operations) => Message.SucceededFetchOperations({ key, operations })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchOperations({ key, failure }))),
		),
})

export const FetchTimeseries = Command.define("FetchLocalServiceOperationsTimeseries", {
	args: { ...Window, spanNames: Schema.Array(Schema.String), bucketSeconds: Schema.Number },
	messages: [Message.SucceededFetchTimeseries, Message.FailedFetchTimeseries],
	execute: ({ key, serviceName, startTime, endTime, apiBase, spanNames, bucketSeconds }) =>
		fetchOperationsTimeseries(serviceName, spanNames, bucketSeconds, { startTime, endTime }, apiBase).pipe(
			Effect.map((points) => Message.SucceededFetchTimeseries({ key, points })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchTimeseries({ key, failure }))),
		),
})

export const FetchGoldenSignals = Command.define("FetchLocalServiceGoldenSignals", {
	args: { ...Window, bucketSeconds: Schema.Number },
	messages: [Message.SucceededFetchGoldenSignals, Message.FailedFetchGoldenSignals],
	execute: ({ key, serviceName, startTime, endTime, apiBase, bucketSeconds }) =>
		fetchGoldenSignals(serviceName, bucketSeconds, { startTime, endTime }, apiBase).pipe(
			Effect.map((rows) => Message.SucceededFetchGoldenSignals({ key, rows })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchGoldenSignals({ key, failure }))),
		),
})
