import { Effect, Result, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import { V2CursorInvalid } from "@maple/domain/http/v2"
import { WarehouseDateTime } from "@maple/query-engine"

/**
 * Opaque keyset cursors for the v2 list endpoints backed by warehouse queries.
 *
 * The wire contract is the one every v2 list shares (`cursor` in, `next_cursor`
 * out); only the payload differs from `paginateOffsetQuery`'s. Keyset is what
 * these lists need rather than a preference: they are ordered newest-first over
 * a table that is being written to while the reader pages through it, so an
 * offset re-slices a window that has already shifted and hands back rows the
 * previous page already showed.
 */
export const encodeKeysetCursor = (prefix: string, parts: ReadonlyArray<string>) =>
	`${prefix}_${Base64Url.encode(JSON.stringify(parts))}`

const decodeCursorParts = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Array(Schema.String)))

/**
 * Decode a keyset cursor into its parts.
 *
 * Element 0 is always the timestamp the keyset walks back from, and it is
 * checked against `WarehouseDateTime` here rather than trusted. It reaches the
 * query builder as a `DateTime` comparison, which encodes it through the
 * column's codec while the query is still being *built* — before `CH.compile`,
 * so outside the Effect that would have turned the failure into a value. A
 * forged cursor was therefore a 500 rather than the 400 this function already
 * knows how to return.
 */
export const decodeKeysetCursor = (value: string | undefined, prefix: string, length: number) => {
	const invalid = Effect.fail(V2CursorInvalid.make(undefined, { param: "cursor" }))
	if (value === undefined) return Effect.succeed<ReadonlyArray<string> | undefined>(undefined)
	if (!value.startsWith(`${prefix}_`)) return invalid
	const decoded = Base64Url.decodeString(value.slice(prefix.length + 1))
	if (Result.isFailure(decoded)) return invalid
	const parsed = decodeCursorParts(decoded.success)
	if (Result.isFailure(parsed)) return invalid
	const parts = parsed.success
	if (parts.length !== length) return invalid
	if (Result.isFailure(Schema.decodeUnknownResult(WarehouseDateTime)(parts[0]))) return invalid
	return Effect.succeed<ReadonlyArray<string> | undefined>(parts)
}
