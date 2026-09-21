import { Schema } from "effect"

/**
 * Schema that decodes a JSON-encoded string into a string array.
 * Handles the case where TanStack Router's parseSearch produces a string
 * (e.g. URL has `?param="[\"val\"]"` which JSON-parses to the string `["val"]`).
 */
const MutableStringArray = Schema.mutable(Schema.Array(Schema.String))
// `mutable` goes INSIDE the JSON decoding: effect rc.116 refuses to make a
// schema that carries an encoding mutable, and the array is what has to be
// mutable for TanStack Router's search params anyway.
const StringArrayFromJsonString = Schema.fromJsonString(Schema.mutable(Schema.Array(Schema.String)))

export const BooleanFromStringParam = Schema.fromJsonString(Schema.Boolean)

/**
 * URL search param number field. TanStack Router's parseSearch yields a string
 * (`?n=30` → `"30"`); this decodes it to a number. Pair with `Schema.Number` in
 * a Union so a value set JS-side by `navigate` (a real number) round-trips too.
 */
export const NumberFromStringParam = Schema.fromJsonString(Schema.Number)

/**
 * Use this for URL search param array fields. Accepts both a real array
 * and a JSON-encoded string, preventing crashes from malformed URLs.
 */
export const OptionalStringArrayParam = Schema.optional(
	Schema.Union([MutableStringArray, StringArrayFromJsonString]),
)
