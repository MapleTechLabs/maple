import { BreakdownRequest, EntryRequest, TimeseriesRequest } from "./requests"
import { cachedAs, withCache } from "../../data/cached"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { MetricEntry } from "../metrics/catalog"
import {
	fetchMetricBreakdown,
	fetchMetricEntry,
	fetchMetricTimeseries,
	BreakdownRow,
	SeriesPoint,
} from "./fetch"
import { Message } from "./message"

export const ReadClock = Command.define("ReadMetricDetailClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadRefreshClock = Command.define("ReadMetricDetailRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs })),
})

const windowKey = (request: Readonly<{ startTime: string; endTime: string }>) =>
	`${request.startTime}/${request.endTime}`
const same = <A>(data: A) => data

export const FetchEntry = Command.define("FetchLocalMetricEntry", {
	args: { ...EntryRequest.fields, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchEntry, Message.FailedFetchEntry, Message.FoundCachedEntry],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ readsCache, ...request }) =>
		withCache({
			key: ["local", "metrics", "entry", request.metricName, windowKey(request)],
			readsCache,
			fromCached: cachedAs(Schema.NullOr(MetricEntry)),
			toCached: same,
			fetch: fetchMetricEntry(request.metricName, request, request.apiBase),
			found: (cached) => Message.FoundCachedEntry({ request, cached }),
			succeeded: (entry, fetchedAtMs) =>
				Message.SucceededFetchEntry({ key: request.key, entry, fetchedAtMs }),
		}).pipe(
			Effect.catch((failure) =>
				Effect.succeed(Message.FailedFetchEntry({ key: request.key, failure })),
			),
		),
})

export const FetchTimeseries = Command.define("FetchLocalMetricTimeseries", {
	args: { ...TimeseriesRequest.fields, readsCache: Schema.Boolean },
	messages: [
		Message.SucceededFetchTimeseries,
		Message.FailedFetchTimeseries,
		Message.FoundCachedTimeseries,
	],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ readsCache, ...request }) =>
		withCache({
			key: [
				"local",
				"metrics",
				"timeseries",
				request.entry.metricName,
				request.entry.metricType,
				request.entry.isMonotonic,
				request.bucketSeconds,
				windowKey(request),
			],
			readsCache,
			fromCached: cachedAs(Schema.Array(SeriesPoint)),
			toCached: (points: ReadonlyArray<SeriesPoint>) => points,
			fetch: Effect.map(
				fetchMetricTimeseries(request.entry, request, request.bucketSeconds, request.apiBase),
				(points): ReadonlyArray<SeriesPoint> => points,
			),
			found: (cached) => Message.FoundCachedTimeseries({ request, cached }),
			succeeded: (points, fetchedAtMs) =>
				Message.SucceededFetchTimeseries({ key: request.key, points, fetchedAtMs }),
		}).pipe(
			Effect.catch((failure) =>
				Effect.succeed(Message.FailedFetchTimeseries({ key: request.key, failure })),
			),
		),
})

export const FetchBreakdown = Command.define("FetchLocalMetricBreakdown", {
	args: { ...BreakdownRequest.fields, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchBreakdown, Message.FailedFetchBreakdown, Message.FoundCachedBreakdown],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ readsCache, ...request }) =>
		withCache({
			key: [
				"local",
				"metrics",
				"breakdown",
				request.entry.metricName,
				request.entry.metricType,
				windowKey(request),
			],
			readsCache,
			fromCached: cachedAs(Schema.Array(BreakdownRow)),
			toCached: same,
			fetch: fetchMetricBreakdown(request.entry, request, request.apiBase),
			found: (cached) => Message.FoundCachedBreakdown({ request, cached }),
			succeeded: (rows, fetchedAtMs) =>
				Message.SucceededFetchBreakdown({ key: request.key, rows, fetchedAtMs }),
		}).pipe(
			Effect.catch((failure) =>
				Effect.succeed(Message.FailedFetchBreakdown({ key: request.key, failure })),
			),
		),
})
