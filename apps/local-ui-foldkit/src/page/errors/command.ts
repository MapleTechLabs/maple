import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
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

export const ReadClock = Command.define("ReadErrorsClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadRefreshClock = Command.define("ReadErrorsRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs })),
})

export const FetchSummary = Command.define("FetchLocalErrorsSummary", {
	args: RequestArgs,
	messages: [Message.SucceededFetchSummary, Message.FailedFetchSummary],
	execute: ({ key, search, startTime, endTime, apiBase }) =>
		fetchErrorsSummary(filtersOf(search), { startTime, endTime }, apiBase).pipe(
			Effect.map((summary) => Message.SucceededFetchSummary({ key, summary })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchSummary({ key, failure }))),
		),
})

export const FetchByType = Command.define("FetchLocalErrorsByType", {
	args: RequestArgs,
	messages: [Message.SucceededFetchByType, Message.FailedFetchByType],
	execute: ({ key, search, startTime, endTime, apiBase }) =>
		Effect.gen(function* () {
			const rows = yield* fetchErrorsByType(filtersOf(search), { startTime, endTime }, apiBase)
			const fetchedAtMs = yield* Clock.currentTimeMillis
			return Message.SucceededFetchByType({ key, rows, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchByType({ key, failure })))),
})

export const FetchFacets = Command.define("FetchLocalErrorsFacets", {
	args: RequestArgs,
	messages: [Message.SucceededFetchFacets, Message.FailedFetchFacets],
	execute: ({ key, search, startTime, endTime, apiBase }) =>
		fetchErrorsFacets(filtersOf(search), { startTime, endTime }, apiBase).pipe(
			Effect.map((facets) => Message.SucceededFetchFacets({ key, facets })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchFacets({ key, failure }))),
		),
})

export const FetchTraces = Command.define("FetchLocalErrorTraces", {
	args: { ...RequestArgs, fingerprintHash: Schema.String },
	messages: [Message.SucceededFetchTraces, Message.FailedFetchTraces],
	execute: ({ key, fingerprintHash, search, startTime, endTime, apiBase }) =>
		fetchErrorTraces(fingerprintHash, filtersOf(search), { startTime, endTime }, apiBase).pipe(
			Effect.map((traces) => Message.SucceededFetchTraces({ fingerprintHash, key, traces })),
			Effect.catch((failure) => Effect.succeed(Message.FailedFetchTraces({ fingerprintHash, key, failure }))),
		),
})
