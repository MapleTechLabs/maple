import { DateTime, Schema, SchemaGetter } from "effect"

const toWire = (value: unknown): unknown => {
	if (DateTime.isDateTime(value)) return DateTime.formatIso(value)
	if (Array.isArray(value)) return value.map(toWire)
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toWire(entry)]))
	}
	return value
}

/**
 * An untyped value on an HTTP response, typically a forwarded warehouse row.
 * Warehouse timestamps decode to `DateTime.Utc`, which JSON cannot carry, so
 * encoding writes any `DateTime` (at any depth) as ISO-8601 with `Z`.
 */
export const WireValue = Schema.Unknown.pipe(
	Schema.decodeTo(Schema.Unknown, {
		decode: SchemaGetter.transform((value: unknown) => value),
		encode: SchemaGetter.transform(toWire),
	}),
)

/** A forwarded row whose columns are not declared: see {@link WireValue}. */
export const WireRow = Schema.Record(Schema.String, WireValue)
