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
	traces: Schema.Array(ErrorDetailTrace),
	/** Error count per bucket, when include_timeseries was set. */
	timeseries: Schema.optionalKey(
		Schema.Array(Schema.Struct({ bucket: Schema.String, count: Schema.Number })),
	),
	service: Schema.optionalKey(Schema.String),
})
