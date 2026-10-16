import { Schema } from "effect"
import { OutputTimeRange } from "./shared"

export const ErrorTypeRow = Schema.Struct({
	fingerprintHash: Schema.String,
	label: Schema.String,
	/** One occurrence's status message, to tell fingerprints with the same label apart. */
	sampleMessage: Schema.String,
	count: Schema.Number,
	affectedServicesCount: Schema.Number,
	lastSeen: Schema.String,
})

export const FindErrorsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	/** "all", or "unexpected" when the list was narrowed to policy-violating identities. */
	identity: Schema.Literals(["all", "unexpected"]),
	errors: Schema.Array(ErrorTypeRow),
	/** On an empty result: filter values that do not exist in the window, with close matches. */
	emptyHints: Schema.optionalKey(Schema.Array(Schema.String)),
	/** Every occurrence in the window, not just the rows shown. */
	totals: Schema.optionalKey(
		Schema.Struct({
			occurrences: Schema.Number,
			fingerprints: Schema.Number,
			/** Occurrences with status Error but no exception recorded. */
			noExceptionCount: Schema.Number,
		}),
	),
})

/** The span that failed inside a sampled trace, with the attributes that say what it was doing. */
export const ErrorDetailSpanSummary = Schema.Struct({
	spanId: Schema.String,
	name: Schema.String,
	serviceName: Schema.String,
	statusMessage: Schema.String,
	attributes: Schema.Record(Schema.String, Schema.String),
})

export const ErrorDetailTrace = Schema.Struct({
	traceId: Schema.String,
	rootSpanName: Schema.String,
	durationMs: Schema.Number,
	spanCount: Schema.Number,
	services: Schema.Array(Schema.String),
	startTime: Schema.String,
	errorMessage: Schema.optionalKey(Schema.String),
	errorSpan: Schema.optionalKey(ErrorDetailSpanSummary),
	logs: Schema.Array(
		Schema.Struct({
			timestamp: Schema.String,
			severityText: Schema.String,
			body: Schema.String,
		}),
	),
})

export const ErrorDetailOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	/** A decimal UInt64 string, never an issue UUID. */
	fingerprintHash: Schema.String,
	/** What the fingerprint is, taken from its newest occurrence. */
	error: Schema.optionalKey(
		Schema.Struct({
			label: Schema.String,
			exceptionType: Schema.String,
			message: Schema.String,
			serviceName: Schema.String,
		}),
	),
	/** Set when the fingerprint was resolved from an error issue id. */
	issueId: Schema.optionalKey(Schema.String),
	/** The fingerprint across its lookback, from error_events; present whenever it occurred. */
	summary: Schema.optionalKey(
		Schema.Struct({
			timeRange: OutputTimeRange,
			occurrences: Schema.Number,
			firstSeen: Schema.String,
			lastSeen: Schema.String,
			services: Schema.Array(Schema.String),
			serviceCount: Schema.Number,
			noExceptionCount: Schema.Number,
		}),
	),
	/** True when no window was given and the samples were read around the last occurrence. */
	anchored: Schema.optionalKey(Schema.Boolean),
	/** Other fingerprints raised in the same sampled traces (often a wrapper and its cause). */
	related: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				fingerprintHash: Schema.String,
				label: Schema.String,
				serviceName: Schema.String,
				traces: Schema.Number,
			}),
		),
	),
	traces: Schema.Array(ErrorDetailTrace),
	/** Error count per bucket, when include_timeseries was set. */
	timeseries: Schema.optionalKey(
		Schema.Array(Schema.Struct({ bucket: Schema.String, count: Schema.Number })),
	),
	service: Schema.optionalKey(Schema.String),
})
