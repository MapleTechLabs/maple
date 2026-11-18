import { splitTerminalClauses } from "@maple-dev/effect-orm/sql"
import { Option, String as Str } from "effect"
import { codeUnitAt } from "@maple/strings"

/**
 * Cap traced SQL at 16 KB. OTel's default attribute size limit is 32 KB, and
 * 16 KB covers the overwhelming majority of compiled DSL queries while leaving
 * headroom for other span attributes. Logs use a tighter cap.
 */
export const SQL_TRACE_MAX = 16_384
export const SQL_LOG_MAX = 1_000

export const truncateSql = (s: string, maxLen: number) =>
	s.length > maxLen ? Str.slice(0, maxLen)(s) + "...[truncated]" : s

const IDENT_CHAR = /[A-Za-z0-9_]/
/** The server reads `$` inside a bare identifier as part of it, so `a$t$` never opens a heredoc. */
const IDENT_PART = /[A-Za-z0-9_$]/
const NUMBER_CHAR = /[A-Za-z0-9_.]/
const HEREDOC_TAG = /^\$[A-Za-z0-9_]*\$/
/** A heredoc tag is short; the scan never looks further ahead for one. */
const MAX_TAG = 130

const at = (text: string, index: number): string => Option.getOrElse(Str.charAt(text, index), () => "")

const from = (text: string, search: string, start: number): number =>
	Option.match(Str.indexOf(search)(Str.slice(start)(text)), {
		onNone: () => -1,
		onSome: (offset) => start + offset,
	})

/** Past a quoted run opened at `i`: `\` escapes and a doubled quote stay inside; unclosed runs to the end. */
const quotedEnd = (sql: string, i: number, quote: string): number => {
	let j = i + 1
	while (j < sql.length) {
		const c = at(sql, j)
		if (c === "\\") j += 2
		else if (c === quote && at(sql, j + 1) === quote) j += 2
		else if (c === quote) return j + 1
		else j++
	}
	return sql.length
}

/** Past a block comment opened at `i`, nested as the server nests them; unclosed runs to the end. */
const blockCommentEnd = (sql: string, i: number): number => {
	let depth = 1
	let j = i + 2
	while (j < sql.length && depth > 0) {
		if (at(sql, j) === "/" && at(sql, j + 1) === "*") {
			depth++
			j += 2
		} else if (at(sql, j) === "*" && at(sql, j + 1) === "/") {
			depth--
			j += 2
		} else j++
	}
	return depth > 0 ? sql.length : j
}

/**
 * SQL with every string and numeric literal replaced by `?`, for traces and logs: the values are
 * customer data (search text, ids, emails). A left-to-right scan of the server's own token forms:
 * comments (`--`, `#`, `//`, nested block comments) are dropped, strings and heredocs become `?`,
 * a number in any notation (`0x`, `0b`, `1_000`, `1.5e3`) becomes `?`, quoted identifiers stay,
 * and anything unclosed runs to the end. A pure lexer, so it uses local indices.
 */
export const redactSqlLiterals = (sql: string): string => {
	let out = ""
	let i = 0
	while (i < sql.length) {
		const c = at(sql, i)
		const next = at(sql, i + 1)
		if ((c === "-" && next === "-") || (c === "/" && next === "/") || c === "#") {
			const nl = from(sql, "\n", i)
			out += c === "#" ? "#" : `${c}${next}`
			i = nl === -1 ? sql.length : nl
		} else if (c === "/" && next === "*") {
			out += "/* */"
			i = blockCommentEnd(sql, i)
		} else if (c === "'") {
			out += "?"
			i = quotedEnd(sql, i, "'")
		} else if (c === '"' || c === "`") {
			const end = quotedEnd(sql, i, c)
			out += Str.slice(i, end)(sql)
			i = end
		} else if (c === "$" && HEREDOC_TAG.test(Str.slice(i, i + MAX_TAG)(sql))) {
			const tag = Option.getOrElse(
				Option.map(Str.match(HEREDOC_TAG)(Str.slice(i, i + MAX_TAG)(sql)), ([open]) => open),
				() => "$$",
			)
			const close = from(sql, tag, i + tag.length)
			out += "?"
			i = close === -1 ? sql.length : close + tag.length
		} else if (/[0-9]/.test(c)) {
			// Hex and binary have no exponent, so their `e` is a digit, never a sign's anchor.
			const radix = c === "0" && /[xXbB]/.test(next)
			let j = i + 1
			while (j < sql.length) {
				const d = at(sql, j)
				const exponentSign = !radix && (d === "+" || d === "-") && /[eE]/.test(at(sql, j - 1))
				if (NUMBER_CHAR.test(d) || exponentSign) j++
				else break
			}
			out += "?"
			i = j
		} else if (IDENT_CHAR.test(c)) {
			let j = i + 1
			while (j < sql.length && IDENT_PART.test(at(sql, j))) j++
			out += Str.slice(i, j)(sql)
			i = j
		} else {
			out += c
			i++
		}
	}
	return out
}

/**
 * Stable 32-bit FNV-1a hash over SQL with literals and numbers normalized. Lets
 * the same query with different params group together in trace search.
 */
export const fingerprintSql = (s: string): string => {
	const normalized = Str.replace(/\b\d+\b/g, "?")(Str.replace(/'[^']*'/g, "'?'")(s))
	let h = 0x811c9dc5
	for (let i = 0; i < normalized.length; i++) {
		h ^= codeUnitAt(normalized, i)
		h = Math.imul(h, 0x01000193)
	}
	return Str.padStart(8, "0")((h >>> 0).toString(16))
}

/**
 * The SQL verb and primary table of a statement, plus the OTEL
 * `db.query.summary` composed from them.
 */
export interface SqlSummary {
	/** `db.operation.name` — the uppercased leading verb ("SELECT"), or `""`. */
	readonly operation: string
	/** `db.collection.name` — the first table named after from/into/update/join/table, or `""`. */
	readonly collection: string
	/** `db.query.summary` — `"{operation} {collection}"`, either part omitted when empty. */
	readonly summary: string
}

/**
 * Leading verb. Mirrors the RE2 `extract(stmt, '^\\s*(\\w+)')` on the read side —
 * `\w` is `[0-9A-Za-z_]` in both engines. Exported so the parity test can assert
 * this exact pattern still appears in the ClickHouse fragment.
 */
export const SQL_VERB_RE = /^\s*(\w+)/

/**
 * First table named by a from/into/update/join/table clause. The optional `\W`
 * skips one quote/bracket so `from "alert_rules"` yields `alert_rules`. The `i`
 * flag stands in for RE2's inline `(?i)`. Exported for the parity test.
 */
export const SQL_TABLE_RE = /(?:from|into|update|join|table)\s+\W?([\w.]+)/i

/**
 * Derive `db.operation.name` / `db.collection.name` / `db.query.summary` from raw
 * statement text, for instrumentation that only learns the SQL after the fact
 * (the drizzle `logger` fires while the DB span is already open).
 *
 * MUST stay behaviourally identical to `derivedStatementSummarySql` in
 * `@maple/domain/tinybird/db-query-shape-sql` — that fragment is what the
 * warehouse derives a shape label with when `db.query.summary` is ABSENT, and
 * the emitted summary takes precedence over it. If the two disagree, every
 * existing shape in `service_map_db_query_shapes_hourly` forks into a duplicate
 * at the moment we start emitting. `summarize-sql.test.ts` pins the parity.
 */
export const summarizeSql = (sql: string): SqlSummary => {
	if (sql === "") return { operation: "", collection: "", summary: "" }
	const operation = Str.toUpperCase(SQL_VERB_RE.exec(sql)?.[1] ?? "")
	const collection = SQL_TABLE_RE.exec(sql)?.[1] ?? ""
	const summary = Str.trim(`${operation}${collection === "" ? "" : ` ${collection}`}`)
	return { operation, collection, summary }
}

/**
 * Drop a statement's `FORMAT` clause (any format, not just the `FORMAT JSON`
 * the DSL emits) and trailing `;`, keeping any `SETTINGS`.
 *
 * The executor no longer needs this — it settles terminal clauses from the
 * backend dialect before the driver sees the statement. This is for callers
 * that hold compiled SQL as text and hand it straight to a ClickHouse client,
 * which sets the wire format itself and rejects a statement carrying its own.
 */
export const normalizeSqlForClickHouseClient = (sql: string): string => {
	const terminal = splitTerminalClauses(sql)
	return terminal.settings === undefined ? terminal.body : `${terminal.body}\n${terminal.settings}`
}
