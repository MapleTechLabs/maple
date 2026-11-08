import { Array as Arr, DateTime, Option, String as Str } from "effect"
import type { QueryWindow } from "../../port"

// Expansion splices literals by position (split/join), never `String.replace` with a string
// replacement, so a `$&` or `$'` anywhere in the SQL is copied verbatim (see `prepareRawSql`).

const replaceAll = (text: string, search: string, replacement: string): string =>
	Arr.join(Str.split(search)(text), replacement)

/** A UTC DateTime64(3) literal: digits, dashes, colons and a dot only, so nothing to escape. */
export const utcLiteral = (epochMs: number): string => {
	const iso = DateTime.formatIso(DateTime.makeUnsafe(epochMs))
	const text = Str.replace("Z", "")(Str.replace("T", " ")(iso))
	return `toDateTime64('${text}', 3, 'UTC')`
}

const expandCalls = (sql: string, macro: string, render: (column: string) => string): string => {
	const at = Str.indexOf(`${macro}(`)(sql)
	if (Option.isNone(at)) return sql
	const open = at.value + macro.length + 1
	const close = Str.indexOf(")")(Str.slice(open)(sql))
	if (Option.isNone(close)) return sql
	const column = Str.trim(Str.slice(open, open + close.value)(sql))
	const head = Str.slice(0, at.value)(sql)
	const tail = Str.slice(open + close.value + 1)(sql)
	return head + render(column) + expandCalls(tail, macro, render)
}

/** Expands every macro. Assumes `clickHouseSqlIssue` passed, so every argument is a column name. */
export const expandMacros = (sql: string, window: QueryWindow): string => {
	const from = utcLiteral(window.startMs)
	const to = utcLiteral(window.endMs)
	const bucket = Math.max(1, Math.round(window.granularitySeconds))
	// Calls first, then plain names; validation refused any other `$__` word, so none overlaps.
	const filtered = expandCalls(
		sql,
		"$__timeFilter",
		(column) => `(${column} >= ${from} AND ${column} < ${to})`,
	)
	const grouped = expandCalls(
		filtered,
		"$__timeGroup",
		(column) => `toStartOfInterval(${column}, INTERVAL ${bucket} SECOND)`,
	)
	return replaceAll(
		replaceAll(replaceAll(grouped, "$__interval_s", String(bucket)), "$__from", from),
		"$__to",
		to,
	)
}
