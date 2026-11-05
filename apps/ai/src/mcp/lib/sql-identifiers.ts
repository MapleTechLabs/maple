import type { RunSqlRewrite } from "@maple/domain/mcp-outputs"
import {
	describeWarehouseTable,
	listWarehouseTables,
	type TableInfo,
} from "@maple/backend/services/warehouse/warehouse-catalog"
import { Array as Arr, Option, String as Str } from "effect"
import { matchAllIndexed, replaceWith } from "@maple/strings"

/** The column an unknown-identifier error names, as written. */
export const unknownIdentifierName = (message: string): string | undefined => {
	const match = Str.match(
		/identifier [`']([^`']+)[`']|Missing columns: '([^']+)'|no column [`']([^`']+)[`']/i,
	)(message)
	return Option.match(match, { onNone: () => undefined, onSome: (m) => m[1] ?? m[2] ?? m[3] })
}

// String literals (with '' and \' escapes), `--`/`#`/`/* */` comments, and quoted identifiers.
const SQL_TOKEN =
	/'(?:[^'\\]|\\[\s\S]|'')*'?|--[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|`(?:[^`]|``)*`?|"(?:[^"]|"")*"?/g

/**
 * The SQL with literals and comments blanked and quoted identifiers unquoted, keeping every
 * position, so `FROM \`traces\`` reads as a table while `'traces'` does not.
 */
export const identifierText = (sql: string): string =>
	replaceWith(sql, SQL_TOKEN, (token) => {
		if (token[0] !== "`" && token[0] !== '"') return Str.replace(/[^\n]/g, " ")(token)
		const closed = token.length > 1 && Str.endsWith(token[0])(token)
		return ` ${Str.slice(1, closed ? -1 : undefined)(token)}${closed ? " " : ""}`
	})

/** Names of the catalog tables the SQL reads (after FROM, JOIN or a comma), in first-mention order. */
export const referencedTableNames = (sql: string): ReadonlyArray<string> => {
	const text = identifierText(sql)
	return Arr.map(
		Arr.flatMap(listWarehouseTables(), (t) =>
			Option.match(
				Str.search(
					new RegExp(`(?:\\bFROM\\s+|\\bJOIN\\s+|,\\s*)(?:[A-Za-z_]\\w*\\.)?${t.name}\\b`, "i"),
				)(text),
				{ onNone: () => [], onSome: (at) => [{ name: t.name, at }] },
			),
		).sort((a, b) => a.at - b.at),
		(t) => t.name,
	)
}

/** The catalog tables the SQL reads, with their columns, in first-mention order. */
export const referencedTables = (sql: string): ReadonlyArray<TableInfo> =>
	Arr.flatMap(referencedTableNames(sql), (name) => {
		const info = describeWarehouseTable(name)
		return info === null ? [] : [info]
	})

/** `service.name`, `trace_id` and `TRACEID` all fold to `traceid`-style keys. */
const fold = (name: string) => Str.toLowerCase(Str.replace(/[._]/g, "")(name))

/** Names agents write for a column or map key that have only one meaning, by folded name. */
const KNOWN_ALIASES: ReadonlyMap<string, { readonly column: string; readonly expr: string }> = new Map([
	["service", { column: "ServiceName", expr: "ServiceName" }],
	["logbody", { column: "Body", expr: "Body" }],
	["spanstatusmessage", { column: "StatusMessage", expr: "StatusMessage" }],
	["statusdescription", { column: "StatusMessage", expr: "StatusMessage" }],
	["serviceversion", { column: "ResourceAttributes", expr: "ResourceAttributes['service.version']" }],
	["servicenamespace", { column: "ResourceAttributes", expr: "ResourceAttributes['service.namespace']" }],
	[
		"serviceinstanceid",
		{ column: "ResourceAttributes", expr: "ResourceAttributes['service.instance.id']" },
	],
	["errortype", { column: "SpanAttributes", expr: "SpanAttributes['error.type']" }],
])

/**
 * The real expression an unknown identifier was meant to be, only when exactly one fits
 * the tables the query reads: a spelling of a real column (`service.name` → `ServiceName`,
 * `Events.Name` → `EventsName`, `trace_id` → `TraceId`) or a known alias (`ServiceVersion`).
 * In a join the column must belong to one table, or the fix would be ambiguous.
 */
const identifierFix = (
	written: string,
	tables: ReadonlyArray<TableInfo>,
	qualifiers: ReadonlyMap<string, string>,
): string | undefined => {
	const owners = (column: string) =>
		Arr.filter(tables, (t) => Arr.some(t.columns, (c) => c.name === column)).length
	if (owners(written) > 0) return undefined
	const byFold = (name: string, unqualified: boolean) => {
		const columns = new Set(Arr.flatMap(tables, (t) => Arr.map(t.columns, (c) => c.name)))
		const hits = Arr.filter([...columns], (c) => fold(c) === fold(name))
		return hits.length === 1 && (!unqualified || owners(hits[0]) === 1) ? hits[0] : undefined
	}
	const whole = byFold(written, true)
	if (whole !== undefined) return whole
	const alias = KNOWN_ALIASES.get(fold(written))
	if (alias !== undefined && owners(alias.column) === 1) return alias.expr
	// `t.trace_id`: keep the qualifier and fix the column from the table it names.
	const lastDot = Option.filter(Str.lastIndexOf(".")(written), (at) => at > 0)
	if (Option.isNone(lastDot)) return undefined
	const dot = lastDot.value
	const qualified = Arr.findFirst(tables, (t) => t.name === qualifiers.get(Str.slice(0, dot)(written)))
	if (Option.isNone(qualified)) return undefined
	const hits = Arr.filter(
		qualified.value.columns,
		(c) => fold(c.name) === fold(Str.slice(dot + 1)(written)),
	)
	return hits.length === 1 ? `${Str.slice(0, dot + 1)(written)}${hits[0].name}` : undefined
}

const escapeRegExp = (text: string) => Str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")(text)

/**
 * Every use of `written` as an identifier, bare or quoted, replaced by `replacement`.
 * Literals and comments are left alone, as are longer names it is part of and function calls.
 */
const replaceIdentifier = (sql: string, written: string, replacement: string): string => {
	const pattern = new RegExp(`(?<![\\w.])${escapeRegExp(written)}(?![\\w.(])`, "g")
	const spans = Arr.map(matchAllIndexed(identifierText(sql), pattern), (m) => {
		const quote = sql[m.index - 1]
		const quoted = (quote === "`" || quote === '"') && sql[m.index + written.length] === quote
		return quoted
			? { start: m.index - 1, end: m.index + written.length + 1 }
			: { start: m.index, end: m.index + written.length }
	})
	return Arr.reduceRight(
		spans,
		sql,
		(text, { start, end }) => `${Str.slice(0, start)(text)}${replacement}${Str.slice(end)(text)}`,
	)
}

/** SQL words that are never an alias, wherever an alias could stand. */
const KEYWORDS = new Set(
	Str.split(" ")(
		"and or not in is like ilike between as on using where prewhere having qualify group order limit " +
			"offset by asc desc nulls first last union except intersect settings format window over final " +
			"sample array join left right inner outer full cross semi anti any all asof global then else end " +
			"when from with into values interval",
	),
)

/** A relation after FROM, JOIN or a comma, and its alias unless that word is a keyword. */
const RELATION = new RegExp(
	`(?:\\bFROM\\s+|\\bJOIN\\s+|,\\s*)([A-Za-z_][\\w.]*)(?:\\s+(?:AS\\s+)?(?!(?:${Arr.join([...KEYWORDS], "|")})\\b)([A-Za-z_][\\w.]*))?`,
	"gi",
)

const relations = (sql: string) =>
	Arr.map(Arr.fromIterable(Str.matchAll(RELATION)(identifierText(sql))), (m) => ({
		name: m[1],
		alias: m[2],
	}))

/**
 * Names the SQL defines itself, which are never column typos: `AS x`, `x AS (`, a relation's
 * alias (`FROM s service`, CTE or table), and an alias after `)` (`FROM (...) t`, `count() c`).
 */
export const definedNames = (sql: string): ReadonlySet<string> => {
	const text = identifierText(sql)
	return new Set([
		...Arr.map(
			Arr.fromIterable(Str.matchAll(/\bAS\s+([A-Za-z_][\w.]*)|\b([A-Za-z_]\w*)\s+AS\s*\(/gi)(text)),
			(m) => m[1] ?? m[2],
		),
		...Arr.filter(
			Arr.map(Arr.fromIterable(Str.matchAll(/\)\s*([A-Za-z_][\w.]*)/g)(text)), (m) => m[1]),
			(name) => !KEYWORDS.has(Str.toLowerCase(name)),
		),
		...Arr.flatMap(relations(sql), (r) => (r.alias === undefined ? [] : [r.alias])),
	])
}

/** The catalog table each qualifier names: `FROM traces t`, `JOIN logs AS l`, `FROM a, b`. */
const tableQualifiers = (sql: string): ReadonlyMap<string, string> => {
	const catalog = new Set(Arr.map(listWarehouseTables(), (t) => t.name))
	return new Map(
		Arr.flatMap(relations(sql), ({ name, alias }) => {
			const table = Str.split(".")(name).at(-1) ?? name
			if (!catalog.has(table)) return []
			return Arr.map([name, table, ...(alias === undefined ? [] : [alias])], (q) => [q, table] as const)
		}),
	)
}

/**
 * The qualifier of `written` names more than one relation (a CTE in one scope, a table in
 * another), so a rewrite of every `q.col` would also change the scope where it was valid.
 */
const qualifierReused = (sql: string, written: string): boolean => {
	const dot = Option.filter(Str.lastIndexOf(".")(written), (at) => at > 0)
	if (Option.isNone(dot)) return false
	const qualifier = Str.toLowerCase(Str.slice(0, dot.value)(written))
	const binds = Arr.filter(
		relations(sql),
		({ name, alias }) =>
			(alias !== undefined && Str.toLowerCase(alias) === qualifier) ||
			Str.toLowerCase(Str.split(".")(name).at(-1) ?? name) === qualifier,
	)
	return binds.length > 1
}

export type IdentifierRewrite = typeof RunSqlRewrite.Type

/** The SQL with the identifier an error named replaced, or undefined when no single fix fits. */
export const fixUnknownIdentifier = (
	sql: string,
	message: string,
): { readonly sql: string; readonly rewrite: IdentifierRewrite } | undefined => {
	const written = unknownIdentifierName(message)
	if (written !== undefined && qualifierReused(sql, written)) return undefined
	const qualifiers = tableQualifiers(sql)
	// A table alias is a name the query defines, `AS` or not; renaming it breaks the FROM.
	if (written === undefined || definedNames(sql).has(written) || qualifiers.has(written)) return undefined
	const to = identifierFix(written, referencedTables(sql), qualifiers)
	if (to === undefined) return undefined
	const fixed = replaceIdentifier(sql, written, to)
	return fixed === sql ? undefined : { sql: fixed, rewrite: { from: written, to } }
}
