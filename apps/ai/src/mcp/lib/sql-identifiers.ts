import type { RunSqlRewrite } from "@maple/domain/mcp-outputs"
import {
	describeWarehouseTable,
	listWarehouseTables,
	type TableInfo,
} from "@maple/backend/services/warehouse/warehouse-catalog"

/** The column an unknown-identifier error names, as written. */
export const unknownIdentifierName = (message: string): string | undefined => {
	const match = message.match(
		/identifier [`']([^`']+)[`']|Missing columns: '([^']+)'|no column [`']([^`']+)[`']/i,
	)
	return match?.[1] ?? match?.[2] ?? match?.[3]
}

// String literals (with '' and \' escapes), `--`/`#`/`/* */` comments, and quoted identifiers.
const SQL_TOKEN =
	/'(?:[^'\\]|\\[\s\S]|'')*'?|--[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|`(?:[^`]|``)*`?|"(?:[^"]|"")*"?/g

/**
 * The SQL with literals and comments blanked and quoted identifiers unquoted, keeping every
 * position, so `FROM \`traces\`` reads as a table while `'traces'` does not.
 */
export const identifierText = (sql: string): string =>
	sql.replace(SQL_TOKEN, (token) => {
		if (token[0] !== "`" && token[0] !== '"') return token.replace(/[^\n]/g, " ")
		const closed = token.length > 1 && token.endsWith(token[0])
		return ` ${token.slice(1, closed ? -1 : undefined)}${closed ? " " : ""}`
	})

/** Names of the catalog tables the SQL reads (after FROM, JOIN or a comma), in first-mention order. */
export const referencedTableNames = (sql: string): ReadonlyArray<string> => {
	const text = identifierText(sql)
	return listWarehouseTables()
		.map((t) => ({
			name: t.name,
			at: text.search(
				new RegExp(`(?:\\bFROM\\s+|\\bJOIN\\s+|,\\s*)(?:[A-Za-z_]\\w*\\.)?${t.name}\\b`, "i"),
			),
		}))
		.filter((t) => t.at >= 0)
		.sort((a, b) => a.at - b.at)
		.map((t) => t.name)
}

/** The catalog tables the SQL reads, with their columns, in first-mention order. */
export const referencedTables = (sql: string): ReadonlyArray<TableInfo> =>
	referencedTableNames(sql).flatMap((name) => {
		const info = describeWarehouseTable(name)
		return info === null ? [] : [info]
	})

/** `service.name`, `trace_id` and `TRACEID` all fold to `traceid`-style keys. */
const fold = (name: string) => name.replace(/[._]/g, "").toLowerCase()

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
	const owners = (column: string) => tables.filter((t) => t.columns.some((c) => c.name === column)).length
	if (owners(written) > 0) return undefined
	const byFold = (name: string, unqualified: boolean) => {
		const columns = new Set(tables.flatMap((t) => t.columns.map((c) => c.name)))
		const hits = [...columns].filter((c) => fold(c) === fold(name))
		return hits.length === 1 && (!unqualified || owners(hits[0]) === 1) ? hits[0] : undefined
	}
	const whole = byFold(written, true)
	if (whole !== undefined) return whole
	const alias = KNOWN_ALIASES.get(fold(written))
	if (alias !== undefined && owners(alias.column) === 1) return alias.expr
	// `t.trace_id`: keep the qualifier and fix the column from the table it names.
	const dot = written.lastIndexOf(".")
	const qualified =
		dot <= 0 ? undefined : tables.find((t) => t.name === qualifiers.get(written.slice(0, dot)))
	if (qualified === undefined) return undefined
	const hits = qualified.columns.filter((c) => fold(c.name) === fold(written.slice(dot + 1)))
	return hits.length === 1 ? `${written.slice(0, dot + 1)}${hits[0].name}` : undefined
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Every use of `written` as an identifier, bare or quoted, replaced by `replacement`.
 * Literals and comments are left alone, as are longer names it is part of and function calls.
 */
const replaceIdentifier = (sql: string, written: string, replacement: string): string => {
	const pattern = new RegExp(`(?<![\\w.])${escapeRegExp(written)}(?![\\w.(])`, "g")
	const spans = [...identifierText(sql).matchAll(pattern)].map((m) => {
		const quote = sql[m.index - 1]
		const quoted = (quote === "`" || quote === '"') && sql[m.index + written.length] === quote
		return quoted
			? { start: m.index - 1, end: m.index + written.length + 1 }
			: { start: m.index, end: m.index + written.length }
	})
	return spans.reduceRight(
		(text, { start, end }) => `${text.slice(0, start)}${replacement}${text.slice(end)}`,
		sql,
	)
}

/** Words that can follow a closing parenthesis without being an alias. */
const KEYWORDS_AFTER_PAREN = new Set(
	(
		"and or not in is like ilike between as on using where prewhere having qualify group order limit " +
		"offset by asc desc nulls first last union except intersect settings format window over final " +
		"sample array join left right inner outer full cross semi anti any all asof global then else end " +
		"when from with into values interval"
	).split(" "),
)

/**
 * Names the SQL defines itself, which are never column typos: `AS x`, `x AS (`, and an
 * alias straight after a closing parenthesis (`FROM (...) t`, `count() c`).
 */
export const definedNames = (sql: string): ReadonlySet<string> => {
	const text = identifierText(sql)
	return new Set([
		...[...text.matchAll(/\bAS\s+([A-Za-z_][\w.]*)|\b([A-Za-z_]\w*)\s+AS\s*\(/gi)].map(
			(m) => m[1] ?? m[2],
		),
		...[...text.matchAll(/\)\s*([A-Za-z_][\w.]*)/g)]
			.map((m) => m[1])
			.filter((name) => !KEYWORDS_AFTER_PAREN.has(name.toLowerCase())),
	])
}

/** The catalog table each qualifier names: `FROM traces t`, `JOIN logs AS l`, `FROM a, b`. */
const tableQualifiers = (sql: string): ReadonlyMap<string, string> => {
	const catalog = new Set(listWarehouseTables().map((t) => t.name))
	return new Map(
		[
			...identifierText(sql).matchAll(
				/(?:\bFROM\s+|\bJOIN\s+|,\s*)([A-Za-z_][\w.]*)(?:\s+(?:AS\s+)?([A-Za-z_][\w.]*))?/gi,
			),
		].flatMap((m) => {
			const table = m[1].split(".").at(-1) ?? m[1]
			if (!catalog.has(table)) return []
			return [m[1], table, ...(m[2] === undefined ? [] : [m[2]])].map((q) => [q, table] as const)
		}),
	)
}

export type IdentifierRewrite = typeof RunSqlRewrite.Type

/** The SQL with the identifier an error named replaced, or undefined when no single fix fits. */
export const fixUnknownIdentifier = (
	sql: string,
	message: string,
): { readonly sql: string; readonly rewrite: IdentifierRewrite } | undefined => {
	const written = unknownIdentifierName(message)
	const qualifiers = tableQualifiers(sql)
	// A table alias is a name the query defines, `AS` or not; renaming it breaks the FROM.
	if (written === undefined || definedNames(sql).has(written) || qualifiers.has(written)) return undefined
	const to = identifierFix(written, referencedTables(sql), qualifiers)
	if (to === undefined) return undefined
	const fixed = replaceIdentifier(sql, written, to)
	return fixed === sql ? undefined : { sql: fixed, rewrite: { from: written, to } }
}
