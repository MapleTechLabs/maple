import { SpanId, TraceId } from "@maple/domain"
import { Context, type Effect, type Option, Schema } from "effect"
import type { LoadFailure } from "../data/load-failure"

// Where a trace view's reads come from: the dashboard answers them from the API, Maple Local
// from `/local/query`. Views ask through this service and never fetch on their own.

const Attributes = Schema.Record(Schema.String, Schema.String)

/** `SpanEvent` (`@maple/query-engine`): one OTel event with its attributes. */
export const SpanEventData = Schema.Struct({
	name: Schema.String,
	timestamp: Schema.String,
	offsetMs: Schema.Number,
	attributes: Attributes,
})
export type SpanEventData = typeof SpanEventData.Type

/** The full attribute maps and events of one span (the trace tree carries trimmed maps). */
export const SpanDetail = Schema.Struct({
	spanAttributes: Attributes,
	resourceAttributes: Attributes,
	events: Schema.Array(SpanEventData),
})
export type SpanDetail = typeof SpanDetail.Type

/** One log carrying a span's context; `key` names the row when the reader opens it. */
export const LogEntry = Schema.Struct({
	key: Schema.String,
	timestamp: Schema.String,
	severityText: Schema.String,
	body: Schema.String,
})
export type LogEntry = typeof LogEntry.Type

export const SpanDetailRequest = Schema.Struct({
	traceId: TraceId,
	spanId: SpanId,
	/** The span's start: narrows the scan to its partition. */
	timestamp: Schema.String,
})
export type SpanDetailRequest = typeof SpanDetailRequest.Type

export const SpanLogsRequest = Schema.Struct({
	traceId: TraceId,
	spanId: SpanId,
	startTime: Schema.String,
	durationMs: Schema.Number,
	limit: Schema.Number,
})
export type SpanLogsRequest = typeof SpanLogsRequest.Type

export type Cached<A> = Readonly<{ data: A; isFresh: boolean }>

export class TraceSource extends Context.Service<
	TraceSource,
	{
		/** None: the source has no row for the span (the trace's trimmed maps stand in). */
		readonly spanDetail: (request: SpanDetailRequest) => Effect.Effect<Option.Option<SpanDetail>, LoadFailure>
		/** At most `request.limit` logs, newest first. */
		readonly spanLogs: (request: SpanLogsRequest) => Effect.Effect<ReadonlyArray<LogEntry>, LoadFailure>
		/** A source with a result cache: its answer is shown first, then revalidated unless fresh. */
		readonly cachedSpanDetail?: (request: SpanDetailRequest) => Effect.Effect<Option.Option<Cached<SpanDetail>>>
		readonly cachedSpanLogs?: (request: SpanLogsRequest) => Effect.Effect<Option.Option<Cached<ReadonlyArray<LogEntry>>>>
	}
>()("@maple/views/traces/TraceSource") {}
