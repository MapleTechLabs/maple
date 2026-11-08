import { Array as Arr, Option, String as Str } from "effect"
import type { CatalogFieldType } from "@maple/domain/data-sources"

/** `LowCardinality(Nullable(String))` -> `String`. */
export const unwrapType = (nativeType: string): string => {
	const trimmed = Str.trim(nativeType)
	const wrapped = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(trimmed)
	return wrapped?.[1] === undefined ? trimmed : unwrapType(wrapped[1])
}

const NUMBER_RE = /^(?:U?Int\d+|Float\d+|BFloat16|Decimal(?:\d+)?(?:\(.*\))?)$/
const TIMESTAMP_RE = /^(?:Date|Date32|DateTime|DateTime64)(?:\(.*\))?$/
const STRING_RE = /^(?:String|FixedString\(\d+\)|Enum(?:8|16)?\(.*\)|UUID|IPv4|IPv6)$/s
const JSON_RE = /^(?:JSON|Object|Map|Array|Tuple|Nested|Dynamic|Variant)\b/

/** The Maple field type for a ClickHouse column type. */
export const mapClickHouseType = (nativeType: string): CatalogFieldType => {
	const base = unwrapType(nativeType)
	if (base === "Bool") return "boolean"
	if (NUMBER_RE.test(base)) return "number"
	if (TIMESTAMP_RE.test(base)) return "timestamp"
	if (STRING_RE.test(base)) return "string"
	if (JSON_RE.test(base)) return "json"
	return "unknown"
}

/** `012.500` -> `12.5`, `-0.0` -> `0`: how JavaScript prints the same number, for an exactness check. */
const canonicalDecimal = (value: string): string => {
	const trimmed = Str.trim(value)
	const negative = Str.startsWith("-")(trimmed)
	const unsigned = Str.replace(/^[-+]/, "")(trimmed)
	const parts = Str.split(".")(unsigned)
	const whole = parts[0]
	const fraction = parts[1] ?? ""
	const int = Str.replace(/^0+(?=\d)/, "")(whole)
	const frac = Str.replace(/0+$/, "")(fraction)
	const body = frac === "" ? int : `${int}.${frac}`
	return negative && body !== "0" ? `-${body}` : body
}

/**
 * A numeric column's string as a number only when the number prints back to the same value, else as
 * is. Wide types always arrive as strings; every type does under `JSONStringsEachRow`.
 */
export const wideNumber = (nativeType: string, value: string): number | string => {
	if (mapClickHouseType(nativeType) !== "number") return value
	const n = Number(value)
	if (!Number.isFinite(n) || Str.trim(value) === "") return value
	// `-0.00` reads as 0: a negative zero is noise in a result table.
	if (n === 0) return 0
	return String(n) === canonicalDecimal(value) ? n : value
}

const ENUM_VALUE_RE = /'((?:[^'\\]|\\.)*)'\s*=\s*-?\d+/g

/** `Enum8('pending' = 1, 'it\'s' = 2)` -> `["pending", "it's"]`; empty for any other type. */
export const enumValues = (nativeType: string): ReadonlyArray<string> => {
	const base = unwrapType(nativeType)
	if (!/^Enum(?:8|16)?\(/.test(base)) return []
	return Arr.map(Arr.fromIterable(Str.matchAll(ENUM_VALUE_RE)(base)), (match) =>
		Str.replace(/\\(.)/g, "$1")(match[1] ?? ""),
	)
}

const TIME_NAME_ORDER = ["timestamp", "event_time", "created_at", "time", "date"] as const

export interface TimeCandidate {
	readonly name: string
	readonly nativeType: string
	readonly inSortingKey: boolean
}

/** First time-typed sorting-key column, else the first time-typed column with a conventional name. */
export const pickTimeField = (columns: ReadonlyArray<TimeCandidate>): string | undefined => {
	const timed = Arr.filter(columns, (column) => mapClickHouseType(column.nativeType) === "timestamp")
	const sorted = Arr.findFirst(timed, (column) => column.inSortingKey)
	if (Option.isSome(sorted)) return sorted.value.name
	const named = Arr.findFirst(TIME_NAME_ORDER, (wanted) =>
		Arr.some(timed, (column) => Str.toLowerCase(column.name) === wanted),
	)
	return Option.getOrUndefined(
		Option.flatMap(named, (wanted) =>
			Arr.findFirst(timed, (column) => Str.toLowerCase(column.name) === wanted),
		),
	)?.name
}
