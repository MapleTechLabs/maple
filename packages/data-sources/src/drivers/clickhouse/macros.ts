import { Array as Arr, DateTime, String as Str } from "effect"
import { maskLiteralsAndComments } from "@maple/domain/raw-sql"
import type { QueryWindow } from "../../port"

// Expansion splices by position, never `String.replace` with a string replacement, so a `$&`
// or `$'` anywhere in the SQL is copied verbatim (see `prepareRawSql`).

/** A UTC DateTime64(3) literal: digits, dashes, colons and a dot only, so nothing to escape. */
export const utcLiteral = (epochMs: number): string => {
	const iso = DateTime.formatIso(DateTime.makeUnsafe(epochMs))
	const text = Str.replace("Z", "")(Str.replace("T", " ")(iso))
	return `toDateTime64('${text}', 3, 'UTC')`
}

const MACRO_RE = /\$__(timeFilter|timeGroup)\(([^)]*)\)|\$__(interval_s|from|to)(?![\w$])/g

/**
 * Expands every macro outside string literals and comments: matches are found in the masked text
 * (same offsets) and spliced into the original, so `'$__from'` stays the text the author wrote.
 * Assumes `clickHouseSqlIssue` passed, so every argument is a column name.
 */
export const expandMacros = (sql: string, window: QueryWindow): string => {
	const from = utcLiteral(window.startMs)
	const to = utcLiteral(window.endMs)
	const bucket = Math.max(1, Math.round(window.granularitySeconds))
	const render = (call: string | undefined, rawColumn: string, name: string | undefined): string => {
		const column = Str.trim(rawColumn)
		if (call === "timeFilter") return `(${column} >= ${from} AND ${column} < ${to})`
		if (call === "timeGroup") return `toStartOfInterval(${column}, INTERVAL ${bucket} SECOND)`
		return name === "interval_s" ? String(bucket) : name === "from" ? from : to
	}
	const matches = Arr.fromIterable(Str.matchAll(MACRO_RE)(maskLiteralsAndComments(sql)))
	const { out, at } = Arr.reduce(matches, { out: "", at: 0 }, (acc, match) => {
		const start = match.index ?? 0
		const end = start + match[0].length
		// The argument is read from the original: masking only blanks literals, never identifiers.
		const original = Str.slice(start, end)(sql)
		const argument = MACRO_ARGUMENT_RE.exec(original)?.[1] ?? ""
		return {
			out: acc.out + Str.slice(acc.at, start)(sql) + render(match[1], argument, match[3]),
			at: end,
		}
	})
	return out + Str.slice(at)(sql)
}

const MACRO_ARGUMENT_RE = /\(([^)]*)\)/
