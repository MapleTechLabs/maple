import { Option, Schema } from "effect"

const encodeJsonCompact = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown))
const encodeJsonPretty = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

/** The value's JSON text, or `undefined` when it has none (`undefined`, a function, a cycle). */
export const stringifyJson = (value: unknown): string | undefined =>
	Option.getOrUndefined(encodeJsonCompact(value))

/** {@link stringifyJson} indented by two spaces. */
export const stringifyJsonPretty = (value: unknown): string | undefined =>
	Option.getOrUndefined(encodeJsonPretty(value))
