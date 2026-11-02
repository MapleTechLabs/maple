import { CH } from "@maple/query-engine"
import { LogSource, type LogsRequest, type TraceSpans } from "@maple/views/logs/log-source"
import { Clock, Effect, Layer, Option } from "effect"
import { HttpClient } from "effect/http"
import { readCached, recordCached } from "./cached"
import { LocalQueryCache } from "./query-cache"
import { traceCacheKey, traceFromCached, traceToCached } from "./trace-cache"
import { fetchTrace } from "./trace-fetch"
import { readLocalEnv } from "../env"
import { normalizeLog, toLogRecord } from "../lib/log-shape"
import { boundsForRange, WIDEST_RANGE } from "../lib/time"
import { localParams, queryRows } from "./local-query"

// The log views' reads over `/local/query`: a page of logs and a trace's span names (shared with
// the trace page through the result cache).

const fetchLogs = (request: LogsRequest, apiBase: string) => {
	const widest = boundsForRange(WIDEST_RANGE)
	const query = CH.logsListQuery({
		limit: request.limit,
		serviceNames: request.services,
		namespaces: request.namespaces,
		traceId: request.traceId,
		order: request.order,
		resourceAttributeFilters: request.resourceAttributeFilters,
	})
	const bounds = { startTime: request.startTime ?? widest.startTime, endTime: request.endTime ?? widest.endTime }
	return Effect.map(queryRows(CH.compile(query, localParams(bounds)), apiBase), (rows) =>
		rows.map((row) => toLogRecord(normalizeLog(row))),
	)
}

/** The trace's span names and start: the trace page's cached trace, else the same read, recorded. */
const fetchTraceSpans = (traceId: string, apiBase: string) =>
	Effect.gen(function* () {
		const cacheKey = traceCacheKey(traceId)
		const cached = yield* readCached(cacheKey, traceFromCached(traceId))
		const trace = Option.isSome(cached) ? cached.value.data : yield* fetchTrace(traceId, apiBase)
		if (Option.isNone(cached)) yield* recordCached(cacheKey, traceToCached(trace), yield* Clock.currentTimeMillis)
		return Option.match(trace, {
			onNone: (): TraceSpans => ({ traceStartTime: null, spanNames: [] }),
			onSome: (found): TraceSpans => ({
				traceStartTime: found.traceStartTime ?? null,
				spanNames: found.spans.map((span) => ({ spanId: span.spanId, spanName: span.spanName })),
			}),
		})
	})

export const LogSourceLocal = Layer.effect(
	LogSource,
	Effect.gen(function* () {
		const http = yield* HttpClient.HttpClient
		const cache = yield* LocalQueryCache
		const { apiBase } = yield* readLocalEnv
		return LogSource.of({
			listLogs: (request) => fetchLogs(request, apiBase).pipe(Effect.provideService(HttpClient.HttpClient, http)),
			traceSpans: ({ traceId }) =>
				fetchTraceSpans(traceId, apiBase).pipe(
					Effect.provideService(HttpClient.HttpClient, http),
					Effect.provideService(LocalQueryCache, cache),
				),
		})
	}),
)
