import { Option, Record as Rec, Schema } from "effect"

/**
 * A loosely typed row cell as text. Scalars print as themselves; null, undefined and anything
 * structured take the fallback rather than printing `[object Object]`.
 */
export const rowText = (value: unknown, fallback = ""): string => {
	if (typeof value === "string") return value
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
		return value.toString()
	return fallback
}

const decodeAttributeMap = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

/**
 * An attribute map shipped as a JSON string. Malformed JSON is an empty map; a non-string or
 * empty value drops only its own key.
 */
export const parseProjectedAttributes = (raw: string | undefined): Record<string, string> =>
	raw === undefined || raw.length === 0
		? {}
		: Option.match(decodeAttributeMap(raw), {
				onNone: () => ({}),
				onSome: (parsed) =>
					Rec.filter(
						parsed,
						(value): value is string => typeof value === "string" && value.length > 0,
					),
			})
