import { STRUCTURED_MARKER } from "../../../components/ai-elements/renderers/constants"
import { Array, Option, Predicate, Schema } from "effect"

// A tool call's one-line summary, and
// its output split into the report text and the structured `__maple_ui` payload.

const SUMMARY_KEYS = [
	"service",
	"serviceName",
	"query",
	"q",
	"traceId",
	"spanId",
	"name",
	"metric",
	"errorId",
	"issueId",
	"dashboardId",
	"ruleId",
]

/** Boilerplate args present on nearly every Maple tool: never the summary. */
const SUMMARY_EXCLUDE = new Set([
	"start_time",
	"end_time",
	"startTime",
	"endTime",
	"limit",
	"offset",
	"interval",
	"granularity",
	"org_id",
	"orgId",
])

const truncate = (value: string, max = 40): string => {
	const trimmed = value.trim()
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)
const decodeRecord = Schema.decodeUnknownOption(UnknownRecord)

/** The input as a record, when it is a non-array object. */
export const inputRecord = (input: unknown): Option.Option<Readonly<Record<string, unknown>>> =>
	globalThis.Array.isArray(input) ? Option.none() : decodeRecord(input)

const formatArg = (key: string, value: unknown): Option.Option<string> => {
	if (Predicate.isString(value) && value.trim() !== "") return Option.some(`${key}=${truncate(value)}`)
	if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return Option.some(`${key}=${value}`)
	return Option.none()
}

/** The call's most salient argument, `key=value`. */
export const toolSummary = (input: unknown): string | undefined =>
	Option.getOrUndefined(
		Option.flatMap(inputRecord(input), (record) =>
			Option.orElse(
				Array.findFirst(SUMMARY_KEYS, (key) => formatArg(key, record[key])),
				() =>
					Array.findFirst(Object.entries(record), ([key, value]) =>
						SUMMARY_EXCLUDE.has(key) ? Option.none() : formatArg(key, value),
					),
			),
		),
	)

const MARKER_PREFIX = `{"${STRUCTURED_MARKER}":true`

/** Where a legacy joined string's UI blob starts, or -1. */
const markerStart = (text: string): number => {
	const index = text.lastIndexOf(MARKER_PREFIX)
	return index > 0 && text[index - 1] !== "\n" ? -1 : index
}

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** A `__maple_ui` payload: the tool that produced it and its data, read per tool by the renderer. */
export const StructuredPayload = Schema.Struct({ tool: Schema.String, data: Schema.Unknown })
export type StructuredPayload = typeof StructuredPayload.Type
const decodePayload = Schema.decodeUnknownOption(StructuredPayload)

const asStructured = (value: unknown): Option.Option<StructuredPayload> =>
	Option.exists(decodeRecord(value), (record) => STRUCTURED_MARKER in record)
		? decodePayload(value)
		: Option.none()

const parseStructuredFromText = (text: string): Option.Option<StructuredPayload> => {
	const start = markerStart(text)
	return start === -1 ? Option.none() : Option.flatMap(parseJson(text.slice(start).trim()), asStructured)
}

const TextItem = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const decodeTextItem = Schema.decodeUnknownOption(TextItem)
const contentTexts = (record: Readonly<Record<string, unknown>>): Option.Option<ReadonlyArray<string>> =>
	globalThis.Array.isArray(record.content)
		? Option.some(
				record.content.flatMap((item) =>
					Option.toArray(Option.map(decodeTextItem(item), (it) => it.text)),
				),
			)
		: Option.none()

/** The rich payload a Maple tool renders as a table, chart or tree (`{ text, ui }` or the legacy shapes). */
export const extractStructuredData = (output: unknown): Option.Option<StructuredPayload> => {
	if (output === null || output === undefined) return Option.none()
	if (Predicate.isString(output)) return parseStructuredFromText(output)
	return Option.flatMap(decodeRecord(output), (record) => {
		if ("ui" in record) return asStructured(record.ui)
		return Option.flatMap(contentTexts(record), (texts) =>
			Array.findFirst(texts, (text) => parseStructuredFromText(text)),
		)
	})
}

/** The report text of a tool's output; JSON for anything else. */
export const extractOutputText = (output: unknown): string | null => {
	if (output === null || output === undefined) return null
	if (Predicate.isString(output)) {
		const start = markerStart(output)
		return start === -1 ? output : output.slice(0, start).trimEnd()
	}
	return Option.match(decodeRecord(output), {
		onNone: () => JSON.stringify(output, null, 2),
		onSome: (record) => {
			if (Predicate.isString(record.text)) return record.text
			return Option.match(contentTexts(record), {
				onNone: () => JSON.stringify(output, null, 2),
				onSome: (texts) =>
					texts.filter((text) => Option.isNone(parseStructuredFromText(text))).join("\n"),
			})
		},
	})
}
