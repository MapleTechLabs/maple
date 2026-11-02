import { TraceId } from "@maple/domain"
import { Context, type Effect, Schema } from "effect"
import type { LoadFailure } from "../data/load-failure"
import type { LogRecord } from "../ui/logs/log-row-view"

// Where a log view's reads come from: the dashboard answers them from the API, Maple Local from
// `/local/query`. Views ask through this service and never fetch on their own.

const ResourceAttributeFilter = Schema.Struct({
	key: Schema.String,
	value: Schema.String,
	mode: Schema.Literal("equals"),
})

/** A page of logs, newest first unless `order` is `asc`; `listLogs`' input, as plain data. */
export const LogsRequest = Schema.Struct({
	limit: Schema.Number,
	services: Schema.optionalKey(Schema.Array(Schema.String)),
	/** The namespace pin, when the app has one. */
	namespaces: Schema.optionalKey(Schema.Array(Schema.String)),
	traceId: Schema.optionalKey(TraceId),
	startTime: Schema.optionalKey(Schema.String),
	endTime: Schema.optionalKey(Schema.String),
	order: Schema.optionalKey(Schema.Literals(["asc", "desc"])),
	resourceAttributeFilters: Schema.optionalKey(Schema.Array(ResourceAttributeFilter)),
})
export type LogsRequest = typeof LogsRequest.Type

export const TraceSpansRequest = Schema.Struct({ traceId: TraceId, timestamp: Schema.String })
export type TraceSpansRequest = typeof TraceSpansRequest.Type

/** The trace's span names by id and its start, for a log timeline's dividers and offsets. */
export const TraceSpans = Schema.Struct({
	traceStartTime: Schema.NullOr(Schema.String),
	spanNames: Schema.Array(Schema.Struct({ spanId: Schema.String, spanName: Schema.String })),
})
export type TraceSpans = typeof TraceSpans.Type

export class LogSource extends Context.Service<
	LogSource,
	{
		readonly listLogs: (request: LogsRequest) => Effect.Effect<ReadonlyArray<LogRecord>, LoadFailure>
		readonly traceSpans: (request: TraceSpansRequest) => Effect.Effect<TraceSpans, LoadFailure>
	}
>()("@maple/views/logs/LogSource") {}
