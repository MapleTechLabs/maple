import { Array as Arr, Option, String as Str } from "effect"
import {
	COLUMN_IDENT_RE,
	DENY_LIST_RE,
	INTO_OUTFILE_RE,
	MAX_RAW_SQL_LENGTH,
	UNMASKED_SYNTAX,
	disallowedTableFunction,
	isReaderName,
	maskLiteralsAndComments,
} from "@maple/domain/raw-sql"

// Static checks for SQL sent to an org's own ClickHouse. The same shape as Maple's raw SQL
// (`rawSqlIssue`) minus `$__orgFilter` and the system-table ban: the data and the server are the
// org's, isolated by its credentials. `readonly=1` on every request is the real boundary.

export const CLICKHOUSE_MACROS = [
	"$__timeFilter",
	"$__timeGroup",
	"$__interval_s",
	"$__from",
	"$__to",
] as const

const MACROS_HELP = "Supported: $__timeFilter(col), $__timeGroup(col), $__interval_s, $__from, $__to."

const TRAILING_FORMAT_RE = /\s+FORMAT\s+[A-Za-z_][A-Za-z0-9_]*\s*;?\s*$/i
const TRAILING_SEMICOLON_RE = /;\s*$/

/** Drops a trailing `;` and `FORMAT x`: the driver owns the wire format. Offsets read from masked text. */
export const stripTerminal = (sql: string): string => {
	const masked = maskLiteralsAndComments(sql)
	const format = TRAILING_FORMAT_RE.exec(masked)
	if (format !== null) return Str.trimEnd(Str.slice(0, format.index)(sql))
	const semicolon = TRAILING_SEMICOLON_RE.exec(masked)
	return semicolon === null ? Str.trimEnd(sql) : Str.trimEnd(Str.slice(0, semicolon.index)(sql))
}

const macroArgumentIssue = (sql: string): string | null => {
	const bad = Arr.findFirst(
		Arr.flatMap(["$__timeFilter", "$__timeGroup"] as const, (macro) =>
			Arr.map(
				Arr.fromIterable(Str.matchAll(new RegExp(`\\${macro}\\(([^)]*)\\)`, "g"))(sql)),
				(match) => ({
					macro,
					column: Str.trim(match[1] ?? ""),
				}),
			),
		),
		({ column }) => !COLUMN_IDENT_RE.test(column),
	)
	return Option.match(bad, {
		onNone: () => null,
		onSome: ({ macro, column }) =>
			`${macro} argument '${column}' must be a column name (letters, digits, underscores, dots).`,
	})
}

const unknownMacroIssue = (sql: string): string | null => {
	const names = Arr.map(Arr.fromIterable(Str.matchAll(/\$__\w+/g)(sql)), (match) => match[0])
	const unknown = Arr.findFirst(names, (name) => !Arr.some(CLICKHOUSE_MACROS, (macro) => macro === name))
	const bare = Arr.findFirst(
		Arr.fromIterable(Str.matchAll(/\$__(timeFilter|timeGroup)\b(?!\()/g)(sql)),
		() => true,
	)
	if (Option.isSome(unknown)) return `Unknown macro ${unknown.value}. ${MACROS_HELP}`
	if (Option.isSome(bare)) return `$__${bare.value[1]} takes a column: $__${bare.value[1]}(created_at).`
	return null
}

/** The first reason this SQL cannot run on an external ClickHouse source, or null. */
export const clickHouseSqlIssue = (sql: string): string | null => {
	if (Str.trim(sql).length === 0 || sql.length > MAX_RAW_SQL_LENGTH) {
		return `SQL must contain between 1 and ${MAX_RAW_SQL_LENGTH} characters.`
	}
	const masked = maskLiteralsAndComments(sql)
	const unmasked = Arr.findFirst(UNMASKED_SYNTAX, ([pattern]) => pattern.test(masked))
	if (Option.isSome(unmasked)) return Str.replace(/raw SQL/g, "this query")(unmasked.value[1])
	const macroIssue = macroArgumentIssue(sql) ?? unknownMacroIssue(sql)
	if (macroIssue !== null) return macroIssue
	const body = maskLiteralsAndComments(stripTerminal(sql))
	if (Str.includes(";")(body)) return "Send one statement at a time: remove the ';' separators."
	const denied = DENY_LIST_RE.exec(body)
	if (denied !== null) {
		return `'${Str.toUpperCase(denied[1] ?? denied[0])}' is not allowed: Maple only reads from this source.`
	}
	if (INTO_OUTFILE_RE.test(body)) return "INTO OUTFILE is not allowed: results come back to Maple."
	if (!/^\s*(?:\(\s*)*(?:SELECT|WITH)\b/i.test(body)) {
		return "Send a SELECT query (WITH common table expressions are fine)."
	}
	const tableFunction = disallowedTableFunction(sql)
	if (tableFunction !== null) {
		return isReaderName(tableFunction)
			? `Table function '${tableFunction}' is not allowed: it reads outside this database.`
			: `Table function '${tableFunction}(...)' is not allowed where a table goes; only numbers() and generateSeries() are.`
	}
	if (/\bSETTINGS\b/i.test(body)) {
		return "SETTINGS is managed by Maple: queries run read-only under a fixed time and memory budget. Remove it."
	}
	return null
}
