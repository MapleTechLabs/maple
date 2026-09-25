/** Output schemas for the traces and logs MCP tools. */
import { Schema } from "effect"
import { OutputPagination, OutputTimeRange } from "./shared"

const StringMap = Schema.Record(Schema.String, Schema.String)
const CountMap = Schema.Record(Schema.String, Schema.Number)

/** One trace (or, for a span-level search, one matching span) in a list. */
export const TraceSummaryRow = Schema.Struct({
	traceId: Schema.String,
	rootSpanName: Schema.String,
	durationMs: Schema.Number,
	spanCount: Schema.Number,
	services: Schema.Array(Schema.String),
	hasError: Schema.Boolean,
	startTime: Schema.optionalKey(Schema.String),
	errorMessage: Schema.optionalKey(Schema.String),
	resourceAttributes: Schema.optionalKey(StringMap),
})

/** The filters a search_traces call applied, echoed so a next page repeats them. */
export const SearchTracesFilters = Schema.Struct({
	service: Schema.optionalKey(Schema.String),
	hasError: Schema.optionalKey(Schema.Boolean),
	minDurationMs: Schema.optionalKey(Schema.Number),
	maxDurationMs: Schema.optionalKey(Schema.Number),
	httpMethod: Schema.optionalKey(Schema.String),
	spanName: Schema.optionalKey(Schema.String),
	traceId: Schema.optionalKey(Schema.String),
	attributeKey: Schema.optionalKey(Schema.String),
	attributeValue: Schema.optionalKey(Schema.String),
	rootOnly: Schema.Boolean,
})

export const SearchTracesOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	pagination: Schema.optionalKey(OutputPagination),
	traces: Schema.Array(TraceSummaryRow),
	filters: SearchTracesFilters,
	/** True when rows are matching spans (span_name without root_only), not traces. */
	spanLevel: Schema.Boolean,
})

export const TraceDurationStats = Schema.Struct({
	p50Ms: Schema.Number,
	p95Ms: Schema.Number,
	minMs: Schema.Number,
	maxMs: Schema.Number,
})

export const FindSlowTracesOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	stats: Schema.optionalKey(TraceDurationStats),
	traces: Schema.Array(TraceSummaryRow),
	service: Schema.optionalKey(Schema.String),
	environment: Schema.optionalKey(Schema.String),
})

export interface SpanNodeOutput {
	readonly spanId: string
	readonly parentSpanId: string
	readonly spanName: string
	readonly serviceName: string
	readonly spanKind?: string
	readonly durationMs: number
	readonly statusCode: string
	readonly statusMessage: string
	readonly attributes: { readonly [key: string]: string }
	readonly resourceAttributes: { readonly [key: string]: string }
	readonly children: ReadonlyArray<SpanNodeOutput>
}

export const SpanNodeOutput = Schema.Struct({
	spanId: Schema.String,
	parentSpanId: Schema.String,
	spanName: Schema.String,
	serviceName: Schema.String,
	spanKind: Schema.optionalKey(Schema.String),
	durationMs: Schema.Number,
	statusCode: Schema.String,
	statusMessage: Schema.String,
	attributes: StringMap,
	resourceAttributes: StringMap,
	children: Schema.Array(Schema.suspend((): Schema.Codec<SpanNodeOutput> => SpanNodeOutput)),
}).annotate({ identifier: "SpanNode" })

/** Children of a parent that the bounded overview left out. `parentSpanId` "" is the root level. */
export const TraceOmittedSpans = Schema.Struct({
	parentSpanId: Schema.String,
	count: Schema.Number,
	totalDurationMs: Schema.Number,
})

export const InspectTraceOutput = Schema.Struct({
	traceId: Schema.String,
	serviceCount: Schema.Number,
	spanCount: Schema.Number,
	rootDurationMs: Schema.Number,
	/** Spans actually included in `spans` (the bounded overview). */
	renderedSpanCount: Schema.optionalKey(Schema.Number),
	/** Total spans in the trace before the overview cap. */
	totalSpanCount: Schema.optionalKey(Schema.Number),
	/** True when `spans` is a bounded subset of the full trace. */
	truncated: Schema.optionalKey(Schema.Boolean),
	spans: Schema.Array(SpanNodeOutput),
	logs: Schema.Array(
		Schema.Struct({
			timestamp: Schema.String,
			severityText: Schema.String,
			serviceName: Schema.String,
			body: Schema.String,
			spanId: Schema.optionalKey(Schema.String),
		}),
	),
	/** Where the overview collapsed children, per parent. */
	omitted: Schema.Array(TraceOmittedSpans),
	/** True when only error spans, their ancestors and the roots were kept. */
	errorsOnly: Schema.Boolean,
	/** The `timestamp` hint the scan was narrowed around, if one was given. */
	timestamp: Schema.optionalKey(Schema.String),
})

/** The decoded view of an AI agent span, or why there is none. */
export const AiSpanDecode = Schema.Union([
	Schema.TaggedStruct("decoded", {
		/** The rendered conversation and tool calls, as markdown. */
		markdown: Schema.String,
		sessionId: Schema.optionalKey(Schema.String),
	}),
	Schema.TaggedStruct("partial", { readSpans: Schema.Number, hasMore: Schema.Boolean }),
	Schema.TaggedStruct("undecoded", { reason: Schema.String }),
])

export const InspectSpanOutput = Schema.Struct({
	traceId: Schema.String,
	spanId: Schema.String,
	found: Schema.Boolean,
	attributes: StringMap,
	resourceAttributes: StringMap,
	/** Present for AI agent spans. */
	ai: Schema.optionalKey(AiSpanDecode),
	/** The `timestamp` hint the scan was narrowed around, if one was given. */
	timestamp: Schema.optionalKey(Schema.String),
})

export const LogEntryRow = Schema.Struct({
	timestamp: Schema.String,
	severityText: Schema.String,
	serviceName: Schema.String,
	body: Schema.String,
	traceId: Schema.optionalKey(Schema.String),
	spanId: Schema.optionalKey(Schema.String),
})

export const LogSearchFilters = Schema.Struct({
	service: Schema.optionalKey(Schema.String),
	severity: Schema.optionalKey(Schema.String),
	search: Schema.optionalKey(Schema.String),
	traceId: Schema.optionalKey(Schema.String),
	spanId: Schema.optionalKey(Schema.String),
})

export const SearchLogsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	totalCount: Schema.Number,
	pagination: Schema.optionalKey(OutputPagination),
	logs: Schema.Array(LogEntryRow),
	filters: Schema.optionalKey(LogSearchFilters),
})

export const LogPatternRow = Schema.Struct({
	template: Schema.String,
	count: Schema.Number,
	sample: Schema.String,
	severityCounts: CountMap,
	serviceCounts: CountMap,
})

export const MineLogPatternsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	totalSampled: Schema.Number,
	sampleSize: Schema.Number,
	patterns: Schema.Array(LogPatternRow),
	filters: Schema.optionalKey(LogSearchFilters),
})
