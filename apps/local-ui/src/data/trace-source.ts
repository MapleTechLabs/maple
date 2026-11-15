import { LOCAL_ORG_ID } from "@maple/query-engine/local"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { CH, formatWarehouseDateTime, parseSpanEvents } from "@maple/query-engine"
import {
	SpanDetail,
	type SpanDetailRequest,
	type SpanLogsRequest,
	type SpanProfile,
	type SpanProfileRequest,
	TraceSource,
} from "@maple/views/traces/trace-source"
import { Clock, Effect, Layer, Option, Schema, Array as Arr } from "effect"
import { HttpClient } from "effect/http"
import { readLocalEnv } from "../env"
import { LocalLog, logKey, normalizeLog } from "../lib/log-shape"
import { boundsForRange, parseClickHouseDateTime, toClickHouseDateTime, WIDEST_RANGE } from "../lib/time"
import { cachedAs, readCached, recordCached } from "./cached"
import type { QueryKey } from "./cache-store"
import { localParams, queryFirstRow, queryRows, queryRowsIfTableExists } from "./local-query"
import { LocalQueryCache } from "./query-cache"

// The trace views' reads over `/local/query`. Every answer is recorded in the result cache, which
// the views read first (`cachedSpanDetail`, `cachedSpanLogs`) and revalidate unless fresh.

const HOUR_MS = 60 * 60 * 1000

const StoredLogs = Schema.Array(LocalLog)

type LogsRequest = Pick<SpanLogsRequest, "traceId" | "spanId" | "startTime" | "durationMs" | "limit">

const spanDetailCacheKey = (request: SpanDetailRequest): QueryKey => [
	"local",
	"span-detail",
	request.traceId,
	request.spanId,
]

const spanLogsCacheKey = (request: LogsRequest): QueryKey => [
	"local",
	"span-logs",
	request.traceId,
	request.spanId,
	request.startTime,
	request.durationMs,
]

/** One span's full attribute maps, then its events (the detail row names the granules to seek). */
const fetchSpanDetail = (request: SpanDetailRequest, apiBase: string) =>
	Effect.gen(function* () {
		const maybeRow = yield* queryFirstRow(
			CH.compile(CH.spanDetailQuery({ traceId: request.traceId, spanId: request.spanId }), {
				orgId: LOCAL_ORG_ID,
			}),
			apiBase,
		)
		if (Option.isNone(maybeRow)) return Option.none()
		const row = maybeRow.value
		const startMs = parseClickHouseDateTime(row.startTime) ?? 0
		const events = yield* queryFirstRow(
			CH.compile(
				CH.spanEventsQuery({
					traceId: row.traceId,
					spanId: row.spanId,
					serviceName: row.serviceName,
					spanName: row.rawSpanName,
				}),
				{
					orgId: LOCAL_ORG_ID,
					startTime: formatWarehouseDateTime(startMs),
					endTime: formatWarehouseDateTime(startMs + 1000),
				},
			),
			apiBase,
		).pipe(
			Effect.map(Option.match({ onNone: () => [], onSome: parseSpanEvents })),
			// Events are supplementary; a failed lookup must not hide the attributes.
			Effect.orElseSucceed(() => []),
		)
		const detail: SpanDetail = {
			spanAttributes: parseAttributes(row.spanAttributes),
			resourceAttributes: parseAttributes(row.resourceAttributes),
			events,
		}
		const now = yield* Clock.currentTimeMillis
		yield* recordCached(spanDetailCacheKey(request), detail, now)
		return Option.some(detail)
	})

/** Logs emitted within one span, newest first, bounded to the span's own window ±1h; recorded whole. */
export const fetchSpanLogRecords = (request: LogsRequest, apiBase: string) => {
	const startMs = parseClickHouseDateTime(request.startTime)
	const bounds =
		startMs === null
			? boundsForRange(WIDEST_RANGE)
			: {
					startTime: toClickHouseDateTime(startMs - HOUR_MS),
					endTime: toClickHouseDateTime(startMs + Math.max(0, request.durationMs) + HOUR_MS),
				}
	const query = CH.logsListQuery({ traceId: request.traceId, spanId: request.spanId, limit: request.limit })
	return Effect.gen(function* () {
		const rows = yield* queryRows(CH.compile(query, localParams(bounds)), apiBase)
		const logs = Arr.map(rows, normalizeLog)
		const now = yield* Clock.currentTimeMillis
		yield* recordCached(spanLogsCacheKey(request), logs, now)
		return logs
	})
}

/** The span's logs as the cache keeps them (whole `LocalLog`s, the sheet opens on one). */
export const cachedSpanLogRecords = (request: LogsRequest) =>
	readCached(spanLogsCacheKey(request), cachedAs(StoredLogs))

/** The profile's rows carry a slice's first sample time; a slow export can stamp it a little off. */
const PROFILE_PAD_MS = 60_000
const PREFERRED_SAMPLE_TYPE = "cpu"

/**
 * The stacks sampled while a span and its descendants ran. Two reads: which sample types are
 * linked to them (none, for a service without a profiler), then the stacks of one.
 */
const fetchSpanProfile = (request: SpanProfileRequest, apiBase: string) =>
	Effect.gen(function* () {
		const startMs = parseClickHouseDateTime(request.startTime)
		if (startMs === null || request.spanIds.length === 0) return Option.none<SpanProfile>()
		const params = {
			orgId: LOCAL_ORG_ID,
			traceId: request.traceId,
			startTime: toClickHouseDateTime(startMs - PROFILE_PAD_MS),
			endTime: toClickHouseDateTime(startMs + Math.max(0, request.durationMs) + PROFILE_PAD_MS),
		}
		const scope = { trace: true, spanIds: request.spanIds }
		const types = yield* queryRowsIfTableExists(
			CH.compile(CH.profileSampleTypesQuery(scope), params),
			apiBase,
		)
		const chosen = Arr.findFirst(types, (row) => row.sampleType === PREFERRED_SAMPLE_TYPE).pipe(
			Option.orElse(() => Arr.head(types)),
		)
		if (Option.isNone(chosen)) return Option.none<SpanProfile>()
		const stacks = yield* queryRows(
			CH.compile(CH.profileStacksQuery({ ...scope, unit: true }), {
				...params,
				sampleType: chosen.value.sampleType,
				sampleUnit: chosen.value.sampleUnit,
			}),
			apiBase,
		)
		return Option.some<SpanProfile>({
			sampleType: chosen.value.sampleType,
			sampleUnit: chosen.value.sampleUnit,
			totalValue: Number(stacks[0]?.totalValue ?? 0),
			stacks: Arr.map(stacks, (row) => ({
				frames: row.frames,
				files: row.files,
				lines: Arr.map(row.lines, Number),
				value: Number(row.value),
			})),
		})
	})

const toEntry = (log: LocalLog) => ({
	key: logKey(log),
	timestamp: log.timestamp,
	severityText: log.severityText,
	body: log.body,
})

export const TraceSourceLocal = Layer.effect(
	TraceSource,
	Effect.gen(function* () {
		const http = yield* HttpClient.HttpClient
		const cache = yield* LocalQueryCache
		const { apiBase } = yield* readLocalEnv
		const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient | LocalQueryCache>) =>
			effect.pipe(
				Effect.provideService(HttpClient.HttpClient, http),
				Effect.provideService(LocalQueryCache, cache),
			)
		return TraceSource.of({
			spanDetail: (request) => run(fetchSpanDetail(request, apiBase)),
			spanLogs: (request) =>
				run(fetchSpanLogRecords(request, apiBase)).pipe(Effect.map((logs) => Arr.map(logs, toEntry))),
			spanProfile: (request) => run(fetchSpanProfile(request, apiBase)),
			cachedSpanDetail: (request) =>
				run(readCached(spanDetailCacheKey(request), cachedAs(SpanDetail))).pipe(
					Effect.map(Option.map(({ data, isFresh }) => ({ data, isFresh }))),
				),
			cachedSpanLogs: (request) =>
				run(cachedSpanLogRecords(request)).pipe(
					Effect.map(
						Option.map(({ data, isFresh }) => ({ data: Arr.map(data, toEntry), isFresh })),
					),
				),
		})
	}),
)
