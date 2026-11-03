import { DateTime, Schema, SchemaGetter, Array as Arr, Record as Rec } from "effect"

/** What a forwarded row value becomes on the wire. */
export type WireJson =
	| string
	| number
	| boolean
	| null
	| ReadonlyArray<WireJson>
	| { readonly [key: string]: WireJson }

const toWire = (value: unknown): WireJson => {
	if (value === null || value === undefined) return null
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
	if (DateTime.isDateTime(value)) return DateTime.formatIso(value)
	if (value instanceof Date) return value.toISOString()
	if (Arr.isArray(value)) return Arr.map(value, toWire)
	if (typeof value === "object") {
		return Rec.fromEntries(
			Arr.map(
				Arr.filter(Rec.toEntries(value), ([, entry]) => entry !== undefined),
				([key, entry]) => [key, toWire(entry)],
			),
		)
	}
	// Functions and symbols have no JSON form, as in `JSON.stringify`.
	return typeof value === "bigint" ? value.toString() : null
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
