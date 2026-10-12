// Pure helpers for the SQL console (`#/query`): result shaping, cell
// formatting, CSV/JSON export and the starter queries.

import { LocalQueryFailed, LocalQueryUnreachable, type LocalQueryRow } from "@maple/query-engine/local"
import { LOCAL_ORG_ID } from "./constants"

/** Rows rendered in the table; downloads always carry the full result. */
export const DISPLAY_ROW_LIMIT = 1000

/** Cells longer than this are cut in the table and shown whole on hover. */
export const CELL_TRUNCATE_LENGTH = 120

export const TABLES_SQL =
	"SELECT name, total_rows FROM system.tables WHERE database = currentDatabase() ORDER BY name"

export interface ExampleQuery {
	readonly label: string
	readonly sql: string
}

export const EXAMPLE_QUERIES: ReadonlyArray<ExampleQuery> = [
	{
		label: "Top services by spans (1h)",
		sql: `SELECT ServiceName, count() AS spans
FROM traces
WHERE OrgId = '${LOCAL_ORG_ID}' AND Timestamp >= now() - INTERVAL 1 HOUR
GROUP BY ServiceName
ORDER BY spans DESC
LIMIT 20`,
	},
	{
		label: "Slowest spans (1h)",
		sql: `SELECT Timestamp, ServiceName, SpanName, round(Duration / 1e6, 2) AS duration_ms, TraceId
FROM traces
WHERE OrgId = '${LOCAL_ORG_ID}' AND Timestamp >= now() - INTERVAL 1 HOUR
ORDER BY Duration DESC
LIMIT 50`,
	},
	{
		label: "Recent error logs",
		sql: `SELECT Timestamp, ServiceName, SeverityText, Body, TraceId
FROM logs
WHERE OrgId = '${LOCAL_ORG_ID}' AND SeverityNumber >= 17
ORDER BY Timestamp DESC
LIMIT 100`,
	},
]

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A table name as SQL: bare when it can be, backtick-quoted otherwise. */
export function quoteIdentifier(name: string): string {
	return PLAIN_IDENTIFIER.test(name) ? name : `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``
}

export function tablePreviewSql(table: string): string {
	return `SELECT *\nFROM ${quoteIdentifier(table)}\nWHERE OrgId = '${LOCAL_ORG_ID}'\nLIMIT 100`
}

export interface LocalTable {
	readonly name: string
	readonly totalRows: number | null
}

/** `system.tables` rows to names; `total_rows` arrives as a number, a quoted UInt64, or null. */
export function parseTables(rows: ReadonlyArray<LocalQueryRow>): ReadonlyArray<LocalTable> {
	return rows.flatMap((row) => {
		const name = row.name
		if (typeof name !== "string") return []
		const total = Number(row.total_rows)
		return [{ name, totalRows: row.total_rows == null || !Number.isFinite(total) ? null : total }]
	})
}

/** Column names in first-seen order across every row. */
export function inferColumns(rows: ReadonlyArray<LocalQueryRow>): ReadonlyArray<string> {
	const seen = new Set<string>()
	for (const row of rows) for (const key of Object.keys(row)) seen.add(key)
	return [...seen]
}

const NUMERIC_TEXT = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

/** Numeric when every non-null value is a number or a quoted 64-bit integer. */
export function isNumericColumn(rows: ReadonlyArray<LocalQueryRow>, column: string): boolean {
	let sawValue = false
	for (const row of rows) {
		const value = row[column]
		if (value == null) continue
		if (typeof value === "number" || (typeof value === "string" && NUMERIC_TEXT.test(value))) {
			sawValue = true
			continue
		}
		return false
	}
	return sawValue
}

/** A cell as display text: `NULL` for null, JSON for arrays, maps and tuples. */
export function formatCell(value: unknown): string {
	if (value === null || value === undefined) return "NULL"
	if (typeof value === "string") return value
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
		return String(value)
	return JSON.stringify(value)
}

export function truncateCell(text: string, max = CELL_TRUNCATE_LENGTH): string {
	return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Text a spreadsheet would evaluate as a formula; numbers are exempt so negatives stay numeric. */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/

const csvField = (value: unknown): string => {
	if (value === null || value === undefined) return ""
	const formatted = formatCell(value)
	const text = typeof value === "string" && FORMULA_TRIGGER.test(formatted) ? `'${formatted}` : formatted
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** RFC 4180 CSV with a header row; nulls are empty fields. */
export function toCsv(rows: ReadonlyArray<LocalQueryRow>, columns = inferColumns(rows)): string {
	const lines = [columns.map(csvField).join(",")]
	for (const row of rows) lines.push(columns.map((column) => csvField(row[column])).join(","))
	return `${lines.join("\r\n")}\r\n`
}

export function toJson(rows: ReadonlyArray<LocalQueryRow>): string {
	return `${JSON.stringify(rows, null, 2)}\n`
}

export interface QueryErrorDescription {
	readonly title: string
	readonly detail: string
}

const READ_ONLY_PREFIX = "read-only query endpoint: "

/** A failed run as a heading plus the server's own message. */
export function describeQueryError(error: unknown): QueryErrorDescription {
	if (error instanceof LocalQueryFailed) {
		if (error.detail.startsWith(READ_ONLY_PREFIX))
			return { title: "Query not allowed", detail: error.detail.slice(READ_ONLY_PREFIX.length) }
		return {
			title: error.status === 400 ? "Query failed" : `Query failed (${error.status})`,
			detail: error.detail || error.message,
		}
	}
	if (error instanceof LocalQueryUnreachable)
		return { title: "Maple Local is unreachable", detail: error.message }
	return { title: "Query failed", detail: error instanceof Error ? error.message : String(error) }
}

export function formatElapsed(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}
