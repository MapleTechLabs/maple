import { Schema } from "effect"

const UnknownJson = Schema.fromJsonString(Schema.Unknown)
const PrettyUnknownJson = Schema.fromJsonString(Schema.Unknown, { space: 2 })

/** Compact JSON text; throws like `JSON.stringify` on values with no JSON form. */
export const encodeJson = Schema.encodeSync(UnknownJson)
/** Two-space indented JSON text. */
export const encodeJsonPretty = Schema.encodeSync(PrettyUnknownJson)
export const encodeJsonEffect = Schema.encodeEffect(UnknownJson)
export const encodeJsonPrettyEffect = Schema.encodeEffect(PrettyUnknownJson)

/** Parses JSON text; throws like `JSON.parse` on malformed input. */
export const decodeJsonSync = Schema.decodeUnknownSync(UnknownJson)
export const decodeJsonEffect = Schema.decodeUnknownEffect(UnknownJson)
