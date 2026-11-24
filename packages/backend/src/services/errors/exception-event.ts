import { Array as Arr, Option, Schema } from "effect"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeNames = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const decodeAttributes = Schema.decodeUnknownOption(Schema.Array(Schema.Record(Schema.String, Schema.String)))

/** A span's events as the warehouse returns them: `toJSONString(EventsName)` and `toJSONString(EventsAttributes)`. */
export interface SpanEventsJson {
	readonly eventsName: string
	readonly eventsAttributes: string
}

/** An attribute of the span's first `exception` event, as the error-events view reads that event. */
export const exceptionEventAttribute = (span: SpanEventsJson, key: string): string | undefined => {
	const names = Option.getOrElse(Option.flatMap(decodeJson(span.eventsName), decodeNames), () => [])
	const attributes = Option.getOrElse(
		Option.flatMap(decodeJson(span.eventsAttributes), decodeAttributes),
		() => [],
	)
	const index = Arr.findFirstIndex(names, (name) => name === "exception")
	return Option.getOrUndefined(Option.flatMap(index, (i) => Option.fromNullishOr(attributes[i]?.[key])))
}
