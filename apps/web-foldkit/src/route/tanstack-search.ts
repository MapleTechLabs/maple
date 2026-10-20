import { Option, Predicate, Record, Schema, SchemaGetter } from "effect"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

// TanStack Router's default search format: each value is JSON when it parses as JSON, raw
// otherwise, and a string that would parse as JSON is written quoted. Same URLs both ways.

const parseValue = (raw: string): Schema.Json => Option.getOrElse(decodeJson(raw), () => raw)

const isJson = (raw: string): boolean => Option.isSome(decodeJson(raw))

const stringifyValue = (value: unknown): Option.Option<string> => {
	if (value === undefined) {
		return Option.none()
	}

	if (Predicate.isString(value)) {
		return Option.some(isJson(value) ? JSON.stringify(value) : value)
	}

	return Option.some(JSON.stringify(value))
}

const parseSearch = (record: Readonly<Record<string, string>>) => ({ search: Record.map(record, parseValue) })

const stringifySearch = (decoded: unknown): Record<string, string> =>
	Predicate.isObject(decoded) && "search" in decoded && Predicate.isObject(decoded.search)
		? Record.getSomes(Record.map(Record.fromEntries(Object.entries(decoded.search)), stringifyValue))
		: {}

/**
 * A query string in the order the entries are given, as TanStack writes a `search` object literal
 * (`{ t, spanId }`): the route codec writes its schema's field order instead.
 */
export const orderedSearch = (entries: ReadonlyArray<readonly [string, string | undefined]>): string => {
	const query = new URLSearchParams(
		entries.flatMap(([key, value]) => Option.toArray(Option.map(stringifyValue(value), (raw) => [key, raw]))),
	).toString()
	return query === "" ? "" : `?${query}`
}

const SearchRecord = Schema.Record(Schema.String, Schema.String)

/** The query codec of a route: its search schema, carried as the route's `search`. */
export const tanstackSearch = <A, I>(schema: Schema.Codec<A, I>) =>
	SearchRecord.pipe(
		Schema.decodeTo(Schema.Unknown, {
			decode: SchemaGetter.transform(parseSearch),
			encode: SchemaGetter.transform(stringifySearch),
		}),
		Schema.decodeTo(Schema.Struct({ search: schema })),
	)
