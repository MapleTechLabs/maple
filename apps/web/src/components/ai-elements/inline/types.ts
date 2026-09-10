import { Schema } from "effect"

/**
 * The payloads a model may embed in a reply. They are model output, not tool
 * output, so every field is validated before it reaches a card — a hallucinated
 * shape renders as text rather than crashing the transcript.
 */

export const InlineTraceData = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	durationMs: Schema.Number,
	hasError: Schema.optionalKey(Schema.Boolean),
	spanCount: Schema.optionalKey(Schema.Number),
	services: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type InlineTraceData = Schema.Schema.Type<typeof InlineTraceData>

export const InlineServiceData = Schema.Struct({
	name: Schema.String,
	/** Requests per minute — the unit every service-metric tool reports. */
	throughputRpm: Schema.optionalKey(Schema.Number),
	/** Percent, not a fraction: 45.45 means 45.45%. */
	errorRate: Schema.optionalKey(Schema.Number),
	/** Whichever percentile the tool returned; the card labels the one it was given. */
	p95Ms: Schema.optionalKey(Schema.Number),
	p99Ms: Schema.optionalKey(Schema.Number),
})
export type InlineServiceData = Schema.Schema.Type<typeof InlineServiceData>

export const InlineErrorData = Schema.Struct({
	errorType: Schema.String,
	count: Schema.optionalKey(Schema.Number),
	affectedServices: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type InlineErrorData = Schema.Schema.Type<typeof InlineErrorData>

export const InlineLogData = Schema.Struct({
	severity: Schema.String,
	body: Schema.String,
	serviceName: Schema.optionalKey(Schema.String),
	timestamp: Schema.optionalKey(Schema.String),
	traceId: Schema.optionalKey(Schema.String),
})
export type InlineLogData = Schema.Schema.Type<typeof InlineLogData>

export type Segment =
	| { type: "text"; content: string }
	| { type: "trace"; data: InlineTraceData }
	| { type: "service"; data: InlineServiceData }
	| { type: "error"; data: InlineErrorData }
	| { type: "log"; data: InlineLogData }
