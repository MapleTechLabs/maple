import { TraceId } from "@maple/domain"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { getLogsCount } from "@maple/web-data/warehouse/logs"
import { getProductEventsForTrace } from "@maple/web-data/warehouse/product-events"
import { getReplaysForTrace } from "@maple/web-data/warehouse/replays"
import { getSpanHierarchy, getTraceSpanEvents } from "@maple/web-data/warehouse/traces"
import { Clock, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { Message } from "./message"

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

export const FetchHierarchy = Command.define("FetchSpanHierarchy", {
	args: { key: Schema.String, traceId: TraceId, timestamp: Schema.optional(Schema.String) },
	messages: [Message.CompletedFetchHierarchy],
	execute: ({ key, traceId, timestamp }) =>
		getSpanHierarchy({ data: { traceId, timestamp } }).pipe(
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
		getTraceSpanEvents({ data: { traceId, traceStartTime, totalDurationMs } }).pipe(
			Effect.map((events) => Object.fromEntries(events)),
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
		getLogsCount({ data: { traceId, startTime, endTime } }).pipe(
			Effect.map((response) => response.data[0]?.total ?? 0),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchLogsCount({ key, result })),
		),
})

export const FetchProductEvents = Command.define("FetchTraceProductEvents", {
	args: WindowArgs,
	messages: [Message.CompletedFetchProductEvents],
	execute: ({ key, traceId, startTime, endTime }) =>
		getProductEventsForTrace({ data: { traceId, startTime, endTime } }).pipe(
			Effect.map((response) =>
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
		getReplaysForTrace({ data: { traceId } }).pipe(
			Effect.map((response) => response.data[0]?.sessionId ?? null),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchReplays({ key, result })),
		),
})
