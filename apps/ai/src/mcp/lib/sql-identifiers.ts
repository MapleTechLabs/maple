import type { RunSqlRewrite } from "@maple/domain/mcp-outputs"
import { maskLiteralsAndComments } from "@maple/domain/raw-sql"
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

/** Names of the catalog tables the SQL reads, in first-mention order. */
export const referencedTableNames = (sql: string): ReadonlyArray<string> => {
	const masked = maskLiteralsAndComments(sql)
	return listWarehouseTables()
		.map((t) => ({ name: t.name, at: masked.search(new RegExp(`\\b${t.name}\\b`)) }))
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
	qualifiers: ReadonlySet<string>,
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
	// `t.trace_id`: keep the qualifier, fix the column, but only for a table or alias in scope.
	const dot = written.lastIndexOf(".")
	if (dot <= 0 || !qualifiers.has(written.slice(0, dot))) return undefined
	const column = byFold(written.slice(dot + 1), false)
	return column === undefined ? undefined : `${written.slice(0, dot + 1)}${column}`
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Every use of `written` as an identifier, bare or backticked, replaced by `replacement`.
 * Literals and comments are left alone, as are longer names it is part of and function calls.
 */
const replaceIdentifier = (sql: string, written: string, replacement: string): string => {
	// Unquote only this name's backticks (same length) so other quoting still masks as before.
	const quoted = `\`${written}\``
	const masked = maskLiteralsAndComments(sql.replaceAll(quoted, ` ${written} `))
	const pattern = new RegExp(`(?<![\\w.])${escapeRegExp(written)}(?![\\w.(])`, "g")
	const spans = [...masked.matchAll(pattern)].map((m) =>
		sql.startsWith(quoted, m.index - 1)
			? { start: m.index - 1, end: m.index + written.length + 1 }
			: { start: m.index, end: m.index + written.length },
	)
	return spans.reduceRight(
		(text, { start, end }) => `${text.slice(0, start)}${replacement}${text.slice(end)}`,
		sql,
	)
}

/** Names the SQL defines itself (`AS x`, `x AS (`), which are never column typos. */
export const definedNames = (sql: string): ReadonlySet<string> =>
	new Set(
		[...maskLiteralsAndComments(sql).matchAll(/\bAS\s+([A-Za-z_]\w*)|\b([A-Za-z_]\w*)\s+AS\s*\(/gi)].map(
			(m) => m[1] ?? m[2],
		),
	)

/** Tables and aliases a column may be qualified with: `FROM traces t`, `JOIN logs AS l`. */
const tableQualifiers = (sql: string): ReadonlySet<string> =>
	new Set(
		[
			...maskLiteralsAndComments(sql).matchAll(
				/\b(?:FROM|JOIN)\s+([A-Za-z_][\w.]*)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi,
			),
		].flatMap((m) => [m[1], m[1].split(".").at(-1) ?? m[1], ...(m[2] === undefined ? [] : [m[2]])]),
	)

export type IdentifierRewrite = typeof RunSqlRewrite.Type

/** The SQL with the identifier an error named replaced, or undefined when no single fix fits. */
export const fixUnknownIdentifier = (
	sql: string,
	message: string,
): { readonly sql: string; readonly rewrite: IdentifierRewrite } | undefined => {
	const written = unknownIdentifierName(message)
	if (written === undefined || definedNames(sql).has(written)) return undefined
	const to = identifierFix(written, referencedTables(sql), tableQualifiers(sql))
	if (to === undefined) return undefined
	const fixed = replaceIdentifier(sql, written, to)
	return fixed === sql ? undefined : { sql: fixed, rewrite: { from: written, to } }
}
