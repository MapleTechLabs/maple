import type { SpanNode } from "@maple/ui/lib/types"
import { SpanId, TraceId } from "@maple/domain"
import { Schema } from "effect"

// The trace the detail page shows, as Model data: `getSpanHierarchy`'s response with the span tree
// kept as a recursive Schema, so every view reads one tree instead of rebuilding it per render.

const Attributes = Schema.Record(Schema.String, Schema.String)

const spanFields = {
	traceId: TraceId,
	spanId: SpanId,
	parentSpanId: Schema.String,
	spanName: Schema.String,
	serviceName: Schema.String,
	spanKind: Schema.String,
	durationMs: Schema.Number,
	startTime: Schema.String,
	statusCode: Schema.String,
	statusMessage: Schema.String,
	spanAttributes: Attributes,
	resourceAttributes: Attributes,
}

export const SpanData = Schema.Struct(spanFields)
export type SpanData = typeof SpanData.Type

/** `SpanNode` (`@maple/ui/lib/types`): a span with its children, depth and skew correction. */
export interface SpanNodeData extends SpanData {
	readonly children: ReadonlyArray<SpanNodeData>
	readonly depth: number
	readonly isMissing?: boolean | undefined
	readonly clockSkewMs?: number | undefined
}

/** The encoded side: ids are plain strings on the wire. */
interface SpanNodeEncoded extends Omit<typeof SpanData.Encoded, "children"> {
	readonly children: ReadonlyArray<SpanNodeEncoded>
	readonly depth: number
	readonly isMissing?: boolean | undefined
	readonly clockSkewMs?: number | undefined
}

export const SpanNodeData: Schema.Codec<SpanNodeData, SpanNodeEncoded> = Schema.Struct({
	...spanFields,
	children: Schema.Array(Schema.suspend((): Schema.Codec<SpanNodeData, SpanNodeEncoded> => SpanNodeData)),
	depth: Schema.Number,
	isMissing: Schema.optional(Schema.Boolean),
	clockSkewMs: Schema.optional(Schema.Number),
})

export const TraceData = Schema.Struct({
	traceId: TraceId,
	spans: Schema.Array(SpanData),
	rootSpans: Schema.Array(SpanNodeData),
	totalDurationMs: Schema.Number,
	traceStartTime: Schema.UndefinedOr(Schema.String),
})
export type TraceData = typeof TraceData.Type

const TimelineEvent = Schema.Struct({ name: Schema.String, offsetMs: Schema.Number })

/** `SpanEventsBySpanId` as a record, span id to its events (the Map does not survive a Message). */
export const SpanEvents = Schema.Record(Schema.String, Schema.Array(TimelineEvent))
export type SpanEvents = typeof SpanEvents.Type

/**
 * The trace helpers take mutable `SpanNode`s; the Model's tree is readonly. They never mutate
 * what they are given, so the tree is copied once at the boundary into their shape.
 */
export const toSpanNode = (node: SpanNodeData): SpanNode => ({
	...node,
	spanAttributes: { ...node.spanAttributes },
	resourceAttributes: { ...node.resourceAttributes },
	children: node.children.map(toSpanNode),
})
