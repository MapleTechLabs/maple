import { GoldenSignalRow, OperationRow, Overview, SeriesPoint } from "./model"
import { cachedAs, withCache } from "../../data/cached"
import { LoadChartRuntime } from "@maple/web/charts/chart-runtime"
import { ResolveThemeColors } from "@maple/web/charts/theme-colors"
import { Clock, Effect, Layer, Schema } from "effect"
import { ServiceDetailDefinition } from "./definition"
import { fetchGoldenSignals, fetchOperations, fetchOperationsTimeseries, fetchOverview } from "./fetch"
import { Message } from "./message"

const Window = {
	key: Schema.String,
	serviceName: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	apiBase: Schema.String,
}

export const ReadClock = ServiceDetailDefinition.makeCommand("ReadServiceDetailClock", {
	messages: [Message.CompletedReadClock],
	handler: function* () {
		return () => Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs }))
	},
})

export const ReadRefreshClock = ServiceDetailDefinition.makeCommand("ReadServiceDetailRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	handler: function* () {
		return () =>
			Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs }))
	},
})

const windowKey = (startTime: string, endTime: string) => `${startTime}/${endTime}`
const same = <A>(data: A) => data

export const FetchOverview = ServiceDetailDefinition.makeCommand("FetchLocalServiceOverview", {
	args: { ...Window, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchOverview, Message.FailedFetchOverview, Message.FoundCachedOverview],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, serviceName, startTime, endTime, apiBase, readsCache }) =>
			withCache({
				key: ["local", "services", "overview", serviceName, windowKey(startTime, endTime)],
				readsCache,
				fromCached: cachedAs(Overview),
				toCached: same,
				fetch: fetchOverview(serviceName, { startTime, endTime }, apiBase),
				found: (cached) => Message.FoundCachedOverview({ key, cached }),
				succeeded: (overview, fetchedAtMs) =>
					Message.SucceededFetchOverview({ key, overview, fetchedAtMs }),
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchOverview({ key, failure }))))
	},
})

export const FetchOperations = ServiceDetailDefinition.makeCommand("FetchLocalServiceOperations", {
	args: { ...Window, readsCache: Schema.Boolean },
	messages: [
		Message.SucceededFetchOperations,
		Message.FailedFetchOperations,
		Message.FoundCachedOperations,
	],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, serviceName, startTime, endTime, apiBase, readsCache }) =>
			withCache({
				key: ["local", "services", "operations", serviceName, windowKey(startTime, endTime)],
				readsCache,
				fromCached: cachedAs(Schema.Array(OperationRow)),
				toCached: same,
				fetch: fetchOperations(serviceName, { startTime, endTime }, apiBase),
				found: (cached) => Message.FoundCachedOperations({ key, cached }),
				succeeded: (operations, fetchedAtMs) =>
					Message.SucceededFetchOperations({ key, operations, fetchedAtMs }),
			}).pipe(
				Effect.catch((failure) => Effect.succeed(Message.FailedFetchOperations({ key, failure }))),
			)
	},
})

export const FetchTimeseries = ServiceDetailDefinition.makeCommand("FetchLocalServiceOperationsTimeseries", {
	args: {
		...Window,
		spanNames: Schema.Array(Schema.String),
		bucketSeconds: Schema.Number,
		readsCache: Schema.Boolean,
	},
	messages: [
		Message.SucceededFetchTimeseries,
		Message.FailedFetchTimeseries,
		Message.FoundCachedTimeseries,
	],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, serviceName, startTime, endTime, apiBase, spanNames, bucketSeconds, readsCache }) =>
			withCache({
				key: [
					"local",
					"services",
					"operations-ts",
					serviceName,
					spanNames,
					bucketSeconds,
					windowKey(startTime, endTime),
				],
				readsCache,
				fromCached: cachedAs(Schema.Array(SeriesPoint)),
				toCached: same,
				fetch: fetchOperationsTimeseries(
					serviceName,
					spanNames,
					bucketSeconds,
					{ startTime, endTime },
					apiBase,
				),
				found: (cached) => Message.FoundCachedTimeseries({ key, cached }),
				succeeded: (points, fetchedAtMs) =>
					Message.SucceededFetchTimeseries({ key, points, fetchedAtMs }),
			}).pipe(
				Effect.catch((failure) => Effect.succeed(Message.FailedFetchTimeseries({ key, failure }))),
			)
	},
})

export const FetchGoldenSignals = ServiceDetailDefinition.makeCommand("FetchLocalServiceGoldenSignals", {
	args: { ...Window, bucketSeconds: Schema.Number, readsCache: Schema.Boolean },
	messages: [
		Message.SucceededFetchGoldenSignals,
		Message.FailedFetchGoldenSignals,
		Message.FoundCachedGoldenSignals,
	],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, serviceName, startTime, endTime, apiBase, bucketSeconds, readsCache }) =>
			withCache({
				key: [
					"local",
					"services",
					"golden-signals",
					serviceName,
					bucketSeconds,
					windowKey(startTime, endTime),
				],
				readsCache,
				fromCached: cachedAs(Schema.Array(GoldenSignalRow)),
				toCached: same,
				fetch: fetchGoldenSignals(serviceName, bucketSeconds, { startTime, endTime }, apiBase),
				found: (cached) => Message.FoundCachedGoldenSignals({ key, cached }),
				succeeded: (rows, fetchedAtMs) =>
					Message.SucceededFetchGoldenSignals({ key, rows, fetchedAtMs }),
			}).pipe(
				Effect.catch((failure) => Effect.succeed(Message.FailedFetchGoldenSignals({ key, failure }))),
			)
	},
})

/** Every handler the page owns; HTTP and the result cache come from the application Layer. */
export const EffectsLayer = Layer.mergeAll(
	ReadClock.layer,
	ReadRefreshClock.layer,
	FetchOverview.layer,
	FetchOperations.layer,
	FetchTimeseries.layer,
	FetchGoldenSignals.layer,
	LoadChartRuntime.layer,
	ResolveThemeColors.layer,
)
