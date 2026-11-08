import { Array as Arr, Option, String as Str } from "effect"
import type { CatalogEntryView, CatalogField, ExternalQuery, QueryLanguage } from "@maple/domain/data-sources"
import { stringifyJson } from "./json"
import { queryLanguageLabel, untrustedText } from "./data-sources"

/** A saved or built query as the model sends it: SQL text, or the resource JSON without its tag. */
export const queryText = (query: ExternalQuery): string => {
	if (query._tag === "sql") return query.sql
	const { _tag: _omit, ...resource } = query
	return stringifyJson(resource) ?? ""
}

const timeFieldOf = (entry: CatalogEntryView): string | undefined =>
	entry.timeField ??
	Arr.findFirst(entry.fields, (field) => field.type === "timestamp").pipe(
		Option.map((field) => field.name),
		Option.getOrUndefined,
	)

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A ClickHouse identifier as SQL: bare when it can be, else backtick-quoted with backticks doubled. */
const quoteIdentifier = (name: string): string =>
	PLAIN_IDENTIFIER.test(name) ? name : `\`${Str.replaceAll("`", "``")(name)}\``

/** `db.table` is stored with one dot between database and table; each part is quoted on its own. */
const quoteTable = (name: string): string => {
	const dot = Str.indexOf(".")(name)
	return Option.match(dot, {
		onNone: () => quoteIdentifier(name),
		onSome: (at) =>
			`${quoteIdentifier(Str.slice(0, at)(name))}.${quoteIdentifier(Str.slice(at + 1)(name))}`,
	})
}

const sqlExample = (entry: CatalogEntryView | undefined): string => {
	if (entry === undefined) return "SELECT count() FROM <table> WHERE $__timeFilter(<time column>)"
	const time = timeFieldOf(entry)
	const table = quoteTable(entry.name)
	// Named columns, never `*`: ClickHouse sources refuse `*` when the table has personal data.
	const columns = Arr.map(
		Arr.take(
			Arr.filter(entry.fields, (field) => field.pii !== true),
			6,
		),
		(field) => quoteIdentifier(field.name),
	)
	if (time === undefined) {
		return `SELECT ${columns.length === 0 ? "count() AS n" : Arr.join(columns, ", ")} FROM ${table} LIMIT 20`
	}
	const column = quoteIdentifier(time)
	return `SELECT $__timeGroup(${column}) AS t, count() AS n FROM ${table} WHERE $__timeFilter(${column}) GROUP BY t ORDER BY t`
}

const resourceExample = (entry: CatalogEntryView | undefined): string => {
	if (entry === undefined) return `{"resource":"<resource>","measure":{"fn":"count"}}`
	const time = timeFieldOf(entry)
	return queryText(
		time === undefined
			? { _tag: "resource", resource: entry.name, limit: 20 }
			: {
					_tag: "resource",
					resource: entry.name,
					measure: { fn: "count" },
					filters: [{ field: time, op: "within_window" }],
					groupBy: { time },
				},
	)
}

/** A runnable query over the first entry with a time field: what the cheat sheet and `next` show. */
export const exampleQuery = (language: QueryLanguage, entries: ReadonlyArray<CatalogEntryView>): string => {
	const first = Arr.findFirst(entries, (entry) => timeFieldOf(entry) !== undefined).pipe(
		Option.orElse(() => Arr.head(entries)),
		Option.getOrUndefined,
	)
	return language === "resource" ? resourceExample(first) : sqlExample(first)
}

/** How to write a query in this source's language, with an example built from its own catalog. */
export const cheatSheet = (
	language: QueryLanguage,
	entries: ReadonlyArray<CatalogEntryView>,
): ReadonlyArray<string> => {
	const example = exampleQuery(language, entries)
	if (language === "resource") {
		return [
			"Query language: resource query. Send `resource` as JSON, never SQL.",
			'Shape: {"resource": name, "measure"?: {"fn": "count"|"count_distinct"|"sum"|"avg"|"min"|"max", "field"?}, "filters"?: [{"field", "op", "value"?}], "groupBy"?: {"time"?: field, "field"?: field}, "select"?: [fields], "orderBy"?: {"field", "dir": "asc"|"desc"}, "limit"?}. No `measure` lists rows.',
			"Filter ops: eq, neq, in, contains, gt, gte, lt, lte, and within_window (binds the field to the query window; no value).",
			"Fields with filter=server are pushed into the API call; filter=client fetches rows and filters after, which costs more calls. Run with explain=true to see the calls first.",
			`Example: ${example}`,
		]
	}
	return [
		`Query language: ${queryLanguageLabel(language)}. Send one read-only SELECT as \`sql\`.`,
		"`$__timeFilter(col)`: keeps rows where col is inside the query window.",
		"`$__timeGroup(col)`: col bucketed to the granularity (granularity_seconds); use it as the time column of a series.",
		"`$__interval_s`: the bucket size in seconds. `$__from` / `$__to`: the window bounds.",
		`Example: ${example}`,
	]
}

/** One field on one line: type, time and PII flags, what the API can do with it, note, samples. */
export const fieldLine = (field: CatalogField, timeField: string | undefined): string => {
	const flags = [
		field.nativeType === undefined ? field.type : `${field.type} (${field.nativeType})`,
		...(field.name === timeField ? ["time field"] : []),
		...(field.pii === true ? ["PII"] : []),
		...(field.capabilities === undefined
			? []
			: [
					`filter=${field.capabilities.filter}`,
					...(field.capabilities.sort ? ["sort"] : []),
					...(field.capabilities.group ? ["group"] : []),
					...(field.capabilities.measure ? ["measure"] : []),
				]),
	]
	const samples =
		field.sampleValues === undefined || field.sampleValues.length === 0
			? ""
			: // Values read from the source: quoted as data, like the admin's note.
				`; e.g. ${Arr.join(
					Arr.map(Arr.take(field.sampleValues, 5), (value) => untrustedText(value, 80)),
					", ",
				)}`
	// The name comes from the source too: one line, so it cannot end the list item.
	return `\`${Str.replace(/\s+/g, " ")(field.name)}\`: ${Arr.join(flags, ", ")}${field.note === undefined ? "" : `; note ${untrustedText(field.note, 200)}`}${samples}`
}
