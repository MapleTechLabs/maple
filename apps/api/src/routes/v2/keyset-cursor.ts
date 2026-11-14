import { Effect, Option, Result, Schema, String as Str } from "effect"
import { Base64Url } from "effect/encoding"
import { V2CursorInvalid } from "@maple/domain/http/v2"
import { parseUtc } from "@maple/query-engine"

const CursorPartsJson = Schema.fromJsonString(Schema.Array(Schema.String))
const encodeCursorParts = Schema.encodeSync(CursorPartsJson)

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
	`${prefix}_${Base64Url.encode(encodeCursorParts(parts))}`

const WAREHOUSE_CURSOR_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/u

const decodeCursorParts = Schema.decodeUnknownResult(CursorPartsJson)

/** A cursor's parts as a tuple of exactly `N` strings. */
export type CursorParts<
	N extends number,
	Acc extends ReadonlyArray<string> = readonly [],
> = Acc["length"] extends N ? Acc : CursorParts<N, readonly [...Acc, string]>

const hasLength = <N extends number>(parts: ReadonlyArray<string>, length: N): parts is CursorParts<N> =>
	parts.length === length

/**
 * Decode a keyset cursor into its parts.
 *
 * Element 0 is always the timestamp the keyset walks back from, and it is
 * checked here rather than trusted: the warehouse shape, with or without the
 * fraction a `DateTime64` row carries. It reaches the
 * query builder as a `DateTime` comparison, which encodes it through the
 * column's codec while the query is still being *built* — before `CH.compile`,
 * so outside the Effect that would have turned the failure into a value. A
 * forged cursor was therefore a 500 rather than the 400 this function already
 * knows how to return.
 */
export const decodeKeysetCursor = <N extends number>(
	value: string | undefined,
	prefix: string,
	length: N,
) => {
	const invalid = Effect.fail(V2CursorInvalid.make(undefined, { param: "cursor" }))
	if (value === undefined) return Effect.succeed<CursorParts<N> | undefined>(undefined)
	if (!Str.startsWith(`${prefix}_`)(value)) return invalid
	const decoded = Base64Url.decodeString(Str.slice(prefix.length + 1)(value))
	if (Result.isFailure(decoded)) return invalid
	const parsed = decodeCursorParts(decoded.success)
	if (Result.isFailure(parsed)) return invalid
	const parts = parsed.success
	const at = parts[0]
	if (!hasLength(parts, length)) return invalid
	if (at === undefined || !WAREHOUSE_CURSOR_TIME.test(at) || Option.isNone(parseUtc(at))) return invalid
	return Effect.succeed<CursorParts<N> | undefined>(parts)
}
