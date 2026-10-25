// JSON round-trip for cached query results. Results hold Effect values
// (`DateTime.Utc` timestamps, `Option`s) that plain JSON would flatten into
// strings and plain objects, so they are tagged on the way out and rebuilt on
// the way in. Anything else that is not plain data makes the result
// unencodable, and the caller skips it instead of restoring a corrupt copy.

import { DateTime, Option } from "effect"

const TAG = "$t"
const MAX_DEPTH = 64

type Encoded = null | boolean | number | string | ReadonlyArray<Encoded> | { readonly [key: string]: Encoded }

/** What `decodeCacheValue` rebuilds: plain data plus the Effect and collection values results hold. */
export type CacheValue =
	| null
	| undefined
	| boolean
	| number
	| string
	| bigint
	| Date
	| DateTime.Utc
	| Option.Some<CacheValue>
	| Option.None<CacheValue>
	| ReadonlyMap<CacheValue, CacheValue>
	| ReadonlySet<CacheValue>
	| ReadonlyArray<CacheValue>
	| { readonly [key: string]: CacheValue }

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (value === null || typeof value !== "object") return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

const encodeAt = (value: unknown, depth: number): Option.Option<Encoded> => {
	if (depth > MAX_DEPTH) return Option.none()
	if (value === null || typeof value === "boolean" || typeof value === "string") return Option.some(value)
	if (value === undefined) return Option.some({ [TAG]: "undefined" })
	if (typeof value === "number")
		return Option.some(Number.isFinite(value) ? value : { [TAG]: "number", v: String(value) })
	if (typeof value === "bigint") return Option.some({ [TAG]: "bigint", v: value.toString() })
	if (typeof value !== "object") return Option.none()
	if (Array.isArray(value)) return encodeAll(value, depth)
	if (DateTime.isDateTime(value))
		return DateTime.isUtc(value)
			? Option.some({ [TAG]: "utc", v: DateTime.toEpochMillis(value) })
			: Option.none()
	if (Option.isOption(value))
		return Option.isSome(value)
			? Option.map(encodeAt(value.value, depth + 1), (v) => ({ [TAG]: "some", v }))
			: Option.some({ [TAG]: "none" })
	if (value instanceof Date) return Option.some({ [TAG]: "date", v: value.getTime() })
	if (value instanceof Map)
		return Option.map(encodeAll([...value.entries()], depth), (v) => ({ [TAG]: "map", v }))
	if (value instanceof Set) return Option.map(encodeAll([...value], depth), (v) => ({ [TAG]: "set", v }))
	if (!isPlainObject(value)) return Option.none()
	const entries = Object.entries(value)
	const fields = encodeAll(
		entries.map(([, field]) => field),
		depth,
	)
	return Option.map(fields, (encoded) => {
		const object = Object.fromEntries(entries.map(([key], index) => [key, encoded[index]]))
		// A real field named like the tag is wrapped so decode never mistakes it for one.
		return TAG in value ? { [TAG]: "object", v: object } : object
	})
}

const encodeAll = (values: ReadonlyArray<unknown>, depth: number): Option.Option<ReadonlyArray<Encoded>> => {
	const out: Array<Encoded> = []
	for (const item of values) {
		const encoded = encodeAt(item, depth + 1)
		if (Option.isNone(encoded)) return Option.none()
		out.push(encoded.value)
	}
	return Option.some(out)
}

/** Encode a query result into JSON-safe data, or `None` when it holds a value this codec cannot rebuild. */
export const encodeCacheValue = (value: unknown): Option.Option<Encoded> => encodeAt(value, 0)

const decodeFields = (object: Record<string, unknown>): { readonly [key: string]: CacheValue } =>
	Object.fromEntries(Object.entries(object).map(([key, field]) => [key, decodeCacheValue(field)]))

/** Rebuild a value written by `encodeCacheValue`. */
export function decodeCacheValue(value: unknown): CacheValue {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	)
		return value
	if (Array.isArray(value)) return value.map(decodeCacheValue)
	if (!isPlainObject(value)) return undefined
	const v = value.v
	switch (value[TAG]) {
		case "undefined":
			return undefined
		case "number":
			return Number(v)
		case "bigint":
			return typeof v === "string" ? BigInt(v) : undefined
		case "utc":
			return typeof v === "number" ? DateTime.makeUnsafe(v) : undefined
		case "some":
			return Option.some(decodeCacheValue(v))
		case "none":
			return Option.none()
		case "date":
			return typeof v === "number" ? new Date(v) : undefined
		case "map":
			return new Map(Array.isArray(v) ? v.map(decodeCacheValue).filter(isPair) : [])
		case "set":
			return new Set(Array.isArray(v) ? v.map(decodeCacheValue) : [])
		case "object":
			return isPlainObject(v) ? decodeFields(v) : undefined
		default:
			return decodeFields(value)
	}
}

const isPair = (entry: CacheValue): entry is readonly [CacheValue, CacheValue] =>
	Array.isArray(entry) && entry.length === 2
