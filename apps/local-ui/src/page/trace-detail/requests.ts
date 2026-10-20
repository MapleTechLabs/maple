import { Schema } from "effect"

// What the span panel's reads ask for; a cached answer carries it back so the fetch can follow.

export const SpanDetailRequest = Schema.Struct({
	key: Schema.String,
	traceId: Schema.String,
	spanId: Schema.String,
	apiBase: Schema.String,
})

export const SpanLogsRequest = Schema.Struct({
	key: Schema.String,
	traceId: Schema.String,
	spanId: Schema.String,
	spanStartTime: Schema.String,
	spanDurationMs: Schema.Number,
	apiBase: Schema.String,
})
