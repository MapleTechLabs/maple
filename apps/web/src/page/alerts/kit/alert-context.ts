import { Option, Schema } from "effect"

/** The `?alert=` payload's fields the incident page reads (the backend sends more). */
const AlertContextSchema = Schema.Struct({ ruleId: Schema.String })

type AlertContext = typeof AlertContextSchema.Type

const decodeAlertContext = Schema.decodeUnknownOption(
	Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(AlertContextSchema))),
)

/** The `?alert=` payload: unpadded base64url UTF-8 JSON; anything undecodable reads as absent. */
export const decodeAlertContextFromSearchParam = (raw: string): AlertContext | undefined =>
	Option.getOrUndefined(decodeAlertContext(raw))

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
			// Never leak a raw enum into prose: these read mid-sentence.
			return signalType.replace(/[_-]+/g, " ")
	}
}
