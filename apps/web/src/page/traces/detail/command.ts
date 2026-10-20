import { TraceId } from "@maple/domain"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { getLogsCount } from "@maple/web-data/warehouse/logs"
import { getProductEventsForTrace } from "@maple/web-data/warehouse/product-events"
import { getReplaysForTrace } from "@maple/web-data/warehouse/replays"
import { getSpanHierarchy, getTraceSpanEvents } from "@maple/web-data/warehouse/traces"
import { Clock, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { IdleTtl } from "../../../data/idle-ttl"
import { toLoadFailure } from "../../../data/load-failure"
import { readThrough } from "../../../data/read-cache"
import { requestKey, type RequestKey } from "../../../data/request-key"
import { writeClipboard } from "../../kit/clipboard"
import { listQueryOf } from "./list-query"
import { Message } from "./message"
import { ProductEvent } from "./model"
import { SpanEvents, TraceData } from "./trace-data"

/** `decodeTraceIdParam`: a pasted id may carry whitespace; anything still undecodable is not found. */
export const decodeTraceId = (raw: string): Option.Option<TraceId> =>
	Schema.decodeUnknownOption(TraceId)(raw.trim())

/** Logs and product events correlate within the trace's span window plus 5 minutes either side. */
const WINDOW_MARGIN_MS = 5 * 60 * 1000

export const correlationWindow = (
	traceStartTime: string,
	totalDurationMs: number,
): Option.Option<{ readonly startTime: string; readonly endTime: string }> => {
	const startMs = parseWarehouseDateTime(traceStartTime)
	return Number.isNaN(startMs)
		? Option.none()
		: Option.some({
				startTime: formatWarehouseDateTime(startMs - WINDOW_MARGIN_MS),
				endTime: formatWarehouseDateTime(startMs + totalDurationMs + WINDOW_MARGIN_MS),
			})
}

export const ReadClock = Command.define("ReadTraceDetailClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

/** The list filters on the page's URL, which its search schema does not decode. */
export const ReadListQuery = Command.define("ReadTraceListQuery", {
	messages: [Message.CompletedReadListQuery],
	execute: Effect.sync(() =>
		Message.CompletedReadListQuery({ listQuery: listQueryOf(window.location.search) }),
	),
})

/** `getSpanHierarchyResultAtom({ data })`'s identity, shared with the investigation's trace chips. */
export const spanHierarchyKey = (
	orgId: string,
	traceId: TraceId,
	timestamp: string | undefined,
): RequestKey => requestKey(orgId, "getSpanHierarchy", { data: { traceId, timestamp } })

/** `getSpanHierarchy` through the read cache, under `spanHierarchyKey`. */
export const readSpanHierarchy = (key: RequestKey, traceId: TraceId, timestamp: string | undefined) =>
	readThrough(
		{ key, idleTtlMs: IdleTtl.spanHierarchy, schema: TraceData },
		getSpanHierarchy({ data: { traceId, timestamp } }),
	)

export const FetchHierarchy = Command.define("FetchSpanHierarchy", {
	args: { key: Schema.String, traceId: TraceId, timestamp: Schema.optional(Schema.String) },
	messages: [Message.CompletedFetchHierarchy],
	execute: ({ key, traceId, timestamp }) =>
		readSpanHierarchy(key, traceId, timestamp).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchHierarchy({ key, result })),
		),
})

export const FetchSpanEvents = Command.define("FetchTraceSpanEvents", {
	args: {
		key: Schema.String,
		traceId: TraceId,
		traceStartTime: Schema.String,
		totalDurationMs: Schema.Number,
	},
	messages: [Message.CompletedFetchSpanEvents],
	execute: ({ key, traceId, traceStartTime, totalDurationMs }) =>
		readThrough(
			{ key, idleTtlMs: IdleTtl.traceSpanEvents, schema: SpanEvents },
			Effect.map(getTraceSpanEvents({ data: { traceId, traceStartTime, totalDurationMs } }), (events) =>
				Object.fromEntries(events),
			),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSpanEvents({ key, result })),
		),
})

const WindowArgs = { key: Schema.String, traceId: TraceId, startTime: Schema.String, endTime: Schema.String }

export const FetchLogsCount = Command.define("FetchTraceLogsCount", {
	args: WindowArgs,
	messages: [Message.CompletedFetchLogsCount],
	execute: ({ key, traceId, startTime, endTime }) =>
		readThrough(
			{ key, idleTtlMs: IdleTtl.logsCount, schema: Schema.Number },
			Effect.map(
				getLogsCount({ data: { traceId, startTime, endTime } }),
				(response) => response.data[0]?.total ?? 0,
			),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchLogsCount({ key, result })),
		),
})

export const FetchProductEvents = Command.define("FetchTraceProductEvents", {
	args: WindowArgs,
	messages: [Message.CompletedFetchProductEvents],
	execute: ({ key, traceId, startTime, endTime }) =>
		readThrough(
			{ key, idleTtlMs: IdleTtl.productEventsForTrace, schema: Schema.Array(ProductEvent) },
			Effect.map(getProductEventsForTrace({ data: { traceId, startTime, endTime } }), (response) =>
				response.data.map((event) => ({
					eventName: event.eventName,
					spanId: event.spanId,
					serviceName: event.serviceName,
					userId: event.userId,
					groupId: event.groupId,
					visitorId: event.visitorId,
					attributes: event.attributes,
				})),
			),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchProductEvents({ key, result })),
		),
})

/** `getReplaysForTraceResultAtom`: the first session that observed the trace, if any. */
export const FetchReplays = Command.define("FetchTraceReplays", {
	args: { key: Schema.String, traceId: TraceId },
	messages: [Message.CompletedFetchReplays],
	execute: ({ key, traceId }) =>
		readThrough(
			{ key, idleTtlMs: IdleTtl.replaysForTrace, schema: Schema.NullOr(Schema.String) },
			Effect.map(
				getReplaysForTrace({ data: { traceId } }),
				(response) => response.data[0]?.sessionId ?? null,
			),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchReplays({ key, result })),
		),
})

/** `TraceIdBadge`'s `useCopy({ label: "trace ID" })`. */
export const CopyTraceId = Command.define("CopyTraceId", {
	args: { traceId: Schema.String },
	messages: [Message.CompletedCopyTraceId],
	execute: ({ traceId }) =>
		Effect.map(writeClipboard(traceId), (isOk) => Message.CompletedCopyTraceId({ isOk })),
})
