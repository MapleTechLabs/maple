import { Option, Schema } from "effect"
import { fromBase64Url } from "../../lib/base64url"

const AlertContextSchema = Schema.Struct({
	ruleId: Schema.String,
	ruleName: Schema.String,
	incidentId: Schema.NullOr(Schema.String),
	eventType: Schema.String,
	signalType: Schema.String,
	severity: Schema.String,
	comparator: Schema.String,
	threshold: Schema.Number,
	value: Schema.NullOr(Schema.Number),
	windowMinutes: Schema.Number,
	groupKey: Schema.NullOr(Schema.String),
	sampleCount: Schema.NullOr(Schema.Number),
	/** Prior AI-triage findings, folded into the chat preamble so the agent starts from them. */
	aiSummary: Schema.optionalKey(Schema.String),
	aiSuspectedCause: Schema.optionalKey(Schema.String),
})

export type AlertContext = typeof AlertContextSchema.Type

const decodeAlertContext = Schema.decodeUnknownOption(AlertContextSchema)

export const decodeAlertContextFromSearchParam = (raw: string): AlertContext | undefined => {
	try {
		return Option.getOrUndefined(decodeAlertContext(JSON.parse(fromBase64Url(raw))))
	} catch {
		return undefined
	}
}

export const signalLabel = (signalType: string): string => {
	switch (signalType) {
		case "error_rate":
			return "error rate"
		case "p95_latency":
			return "p95 latency"
		case "p99_latency":
			return "p99 latency"
		case "apdex":
			return "Apdex"
		case "throughput":
			return "throughput"
		case "builder_query":
			return "query result"
		case "raw_query":
			return "SQL query result"
		default:
			// Never leak a raw enum into prose — these read mid-sentence.
			return signalType.replace(/[_-]+/g, " ")
	}
}
