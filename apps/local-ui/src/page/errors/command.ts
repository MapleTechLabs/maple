import { byTypeFromCached, errorsKey, facetsFromCached, summaryFromCached, tracesFromCached, tracesKey } from "./cache"
import { withCache } from "../../data/cached"
import { Clock, Effect, Layer, Schema } from "effect"
import { ErrorsDefinition } from "./definition"
import { type ErrorsFilters, fetchErrorsByType, fetchErrorsFacets, fetchErrorsSummary, fetchErrorTraces } from "./fetch"
import { Message } from "./message"

/** The view's filters from the hash query (`ErrorsView`). */
export const errorsFiltersOf = (query: URLSearchParams): ErrorsFilters => ({
	service: query.get("service") || undefined,
	env: query.get("env") || undefined,
	rootOnly: query.get("root") === "1",
})

/** What a request reads: the hash query (filters), the window and the server. */
const RequestArgs = {
	key: Schema.String,
	search: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	apiBase: Schema.String,
}

const filtersOf = (search: string) => errorsFiltersOf(new URLSearchParams(search))

export const ReadClock = ErrorsDefinition.makeCommand("ReadErrorsClock", {
	messages: [Message.CompletedReadClock],
	handler: function* () {
		return () => Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs }))
	},
})

export const ReadRefreshClock = ErrorsDefinition.makeCommand("ReadErrorsRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	handler: function* () {
		return () => Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs }))
	},
})

const same = <A>(data: A) => data

export const FetchSummary = ErrorsDefinition.makeCommand("FetchLocalErrorsSummary", {
	args: { ...RequestArgs, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchSummary, Message.FailedFetchSummary, Message.FoundCachedSummary],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, search, startTime, endTime, apiBase, readsCache }) =>
			withCache({
				key: errorsKey("summary", { search, startTime, endTime }),
				readsCache,
				fromCached: summaryFromCached,
				toCached: same,
				fetch: fetchErrorsSummary(filtersOf(search), { startTime, endTime }, apiBase),
				found: (cached) => Message.FoundCachedSummary({ key, cached }),
				succeeded: (summary, fetchedAtMs) => Message.SucceededFetchSummary({ key, summary, fetchedAtMs }),
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchSummary({ key, failure }))))
	},
})

export const FetchByType = ErrorsDefinition.makeCommand("FetchLocalErrorsByType", {
	args: { ...RequestArgs, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchByType, Message.FailedFetchByType, Message.FoundCachedByType],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, search, startTime, endTime, apiBase, readsCache }) =>
			withCache({
				key: errorsKey("by-type", { search, startTime, endTime }),
				readsCache,
				fromCached: byTypeFromCached,
				toCached: same,
				fetch: fetchErrorsByType(filtersOf(search), { startTime, endTime }, apiBase),
				found: (cached) => Message.FoundCachedByType({ key, cached }),
				succeeded: (rows, fetchedAtMs) => Message.SucceededFetchByType({ key, rows, fetchedAtMs }),
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchByType({ key, failure }))))
	},
})

export const FetchFacets = ErrorsDefinition.makeCommand("FetchLocalErrorsFacets", {
	args: { ...RequestArgs, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchFacets, Message.FailedFetchFacets, Message.FoundCachedFacets],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, search, startTime, endTime, apiBase, readsCache }) =>
			withCache({
				key: errorsKey("facets", { search, startTime, endTime }),
				readsCache,
				fromCached: facetsFromCached,
				toCached: same,
				fetch: fetchErrorsFacets(filtersOf(search), { startTime, endTime }, apiBase),
				found: (cached) => Message.FoundCachedFacets({ key, cached }),
				succeeded: (facets, fetchedAtMs) => Message.SucceededFetchFacets({ key, facets, fetchedAtMs }),
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchFacets({ key, failure }))))
	},
})

export const FetchTraces = ErrorsDefinition.makeCommand("FetchLocalErrorTraces", {
	args: { ...RequestArgs, fingerprintHash: Schema.String, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchTraces, Message.FailedFetchTraces, Message.FoundCachedTraces],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, fingerprintHash, search, startTime, endTime, apiBase, readsCache }) =>
			withCache({
				key: tracesKey(fingerprintHash, { search, startTime, endTime }),
				readsCache,
				fromCached: tracesFromCached,
				toCached: same,
				fetch: fetchErrorTraces(fingerprintHash, filtersOf(search), { startTime, endTime }, apiBase),
				found: (cached) => Message.FoundCachedTraces({ fingerprintHash, key, cached }),
				succeeded: (traces, fetchedAtMs) => Message.SucceededFetchTraces({ fingerprintHash, key, traces, fetchedAtMs }),
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchTraces({ fingerprintHash, key, failure }))))
	},
})

export const EffectsLayer = Layer.mergeAll(
	ReadClock.layer,
	ReadRefreshClock.layer,
	FetchSummary.layer,
	FetchByType.layer,
	FetchFacets.layer,
	FetchTraces.layer,
)
