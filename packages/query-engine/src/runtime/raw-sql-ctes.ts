import { String as Str } from "effect"
import { maskLiteralsAndComments } from "@maple-dev/effect-orm/sql"

// A warehouse token with row-level filters only sees a CTE in the query level that
// declares it: a CTE read from another CTE, from a subquery, or through `IN cte`
// fails to resolve. ClickHouse never materializes a CTE (each read re-runs its
// body), so writing the body in place of those reads returns the same rows. Reads
// at the top level of the final SELECT keep the name. A pure text rewrite on the
// masked query, so it uses local indices rather than Effect primitives.

interface Cte {
	readonly name: string
	/** The body between the CTE's parentheses, in the original text. */
	readonly bodyStart: number
	readonly bodyEnd: number
}

interface WithClause {
	readonly ctes: ReadonlyArray<Cte>
	/** Where the final SELECT starts. */
	readonly selectStart: number
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y
const SPACE_RE = /\s*/y
const CTE_HEAD_RE = /([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/iy
const QUERY_START_RE = /^\s*(?:SELECT|WITH)\b/i
const SELECT_RE = /SELECT\b/iy

/** Words that end a table reference, so an identifier after the name is never one of these as an alias. */
const CLAUSE_WORDS = new Set([
	"WHERE",
	"PREWHERE",
	"FINAL",
	"SAMPLE",
	"ARRAY",
	"GLOBAL",
	"ANY",
	"ALL",
	"INNER",
	"LEFT",
	"RIGHT",
	"FULL",
	"CROSS",
	"OUTER",
	"SEMI",
	"ANTI",
	"ASOF",
	"PASTE",
	"JOIN",
	"ON",
	"USING",
	"GROUP",
	"ORDER",
	"LIMIT",
	"OFFSET",
	"HAVING",
	"WINDOW",
	"QUALIFY",
	"UNION",
	"INTERSECT",
	"EXCEPT",
	"SETTINGS",
	"FORMAT",
	"INTO",
])

const skipSpace = (masked: string, at: number): number => {
	SPACE_RE.lastIndex = at
	SPACE_RE.exec(masked)
	return SPACE_RE.lastIndex
}

/** Index of the `)` closing the `(` at `open`, or -1. */
const closingParen = (masked: string, open: number): number => {
	let depth = 0
	for (let i = open; i < masked.length; i++) {
		const c = masked[i]
		if (c === "(") depth++
		else if (c === ")" && --depth === 0) return i
	}
	return -1
}

/** Skip an expression-alias entry (`expr AS name`) to its top-level `,` or the final SELECT. */
const skipExpressionEntry = (masked: string, at: number): number => {
	let depth = 0
	for (let i = at; i < masked.length; i++) {
		const c = masked[i]
		if (c === "(") depth++
		else if (c === ")") depth--
		else if (depth === 0 && c === ",") return i
		else if (depth === 0 && /\s/.test(masked[i - 1] ?? "")) {
			SELECT_RE.lastIndex = i
			if (SELECT_RE.test(masked)) return i
		}
	}
	return -1
}

const parseWithClause = (masked: string): WithClause | null => {
	const head = /^\s*WITH\s+/i.exec(masked)
	if (head === null || /^\s*WITH\s+RECURSIVE\b/i.test(masked)) return null
	const ctes: Array<Cte> = []
	let at = head[0].length
	for (;;) {
		CTE_HEAD_RE.lastIndex = at
		const cte = CTE_HEAD_RE.exec(masked)
		if (cte !== null) {
			const open = CTE_HEAD_RE.lastIndex - 1
			const close = closingParen(masked, open)
			if (close === -1) return null
			// `WITH x AS (1 + 2)` names a value, not a table.
			if (QUERY_START_RE.test(Str.slice(open + 1, close)(masked))) {
				ctes.push({ name: cte[1] ?? "", bodyStart: open + 1, bodyEnd: close })
			}
			at = skipSpace(masked, close + 1)
		} else {
			const end = skipExpressionEntry(masked, at)
			if (end === -1) return null
			at = end
		}
		if (masked[at] === ",") {
			at = skipSpace(masked, at + 1)
			continue
		}
		SELECT_RE.lastIndex = at
		return SELECT_RE.test(masked) ? { ctes, selectStart: at } : null
	}
}

/** Paren depth at every index of `masked`. */
const depthsOf = (masked: string): ReadonlyArray<number> => {
	const depths: Array<number> = []
	let depth = 0
	for (const c of masked) {
		if (c === ")") depth--
		depths.push(depth)
		if (c === "(") depth++
	}
	return depths
}

/** Whether a table name ending at `at` is followed by an alias (`AS t` or a bare `t`). */
const hasAlias = (masked: string, at: number): boolean => {
	const start = skipSpace(masked, at)
	if (start === at) return false
	IDENT_RE.lastIndex = start
	const word = IDENT_RE.exec(masked)?.[0]
	if (word === undefined) return false
	return !CLAUSE_WORDS.has(Str.toUpperCase(word))
}

/**
 * Write each body from `bodies` in place of a read of its CTE in `text`. `keepTopLevel`
 * keeps the reads at paren depth 0 of `text` (the final SELECT's own FROM and JOINs).
 */
const inlineReads = (text: string, bodies: ReadonlyMap<string, string>, keepTopLevel: boolean): string => {
	if (bodies.size === 0) return text
	const masked = maskLiteralsAndComments(text)
	const depths = depthsOf(masked)
	const read = /\b(FROM|JOIN|IN)(\s+)([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*[.(])/gi
	let out = ""
	let last = 0
	for (let m = read.exec(masked); m !== null; m = read.exec(masked)) {
		const name = m[3] ?? ""
		const body = bodies.get(name)
		const nameStart = m.index + (m[1] ?? "").length + (m[2] ?? "").length
		const isIn = Str.toUpperCase(m[1] ?? "") === "IN"
		if (body === undefined || (keepTopLevel && !isIn && depths[m.index] === 0)) continue
		const nameEnd = nameStart + name.length
		const replacement = isIn || hasAlias(masked, nameEnd) ? `(${body})` : `(${body}) AS ${name}`
		out += Str.slice(last, nameStart)(text) + replacement
		last = nameEnd
	}
	return out + Str.slice(last)(text)
}

/** Rewrite a raw query so no CTE is read outside the query level that declares it. */
export const inlineNestedCteReads = (sql: string): string => {
	const masked = maskLiteralsAndComments(sql)
	const clause = parseWithClause(masked)
	if (clause === null || clause.ctes.length === 0) return sql

	// Each body only sees the CTEs declared before it, already self-contained.
	const bodies = new Map<string, string>()
	const rewritten: Array<readonly [Cte, string]> = []
	for (const cte of clause.ctes) {
		const body = inlineReads(Str.slice(cte.bodyStart, cte.bodyEnd)(sql), bodies, false)
		rewritten.push([cte, body])
		bodies.set(cte.name, body)
	}

	let out = ""
	let last = 0
	for (const [cte, body] of rewritten) {
		out += Str.slice(last, cte.bodyStart)(sql) + body
		last = cte.bodyEnd
	}
	out += Str.slice(last, clause.selectStart)(sql)
	return out + inlineReads(Str.slice(clause.selectStart)(sql), bodies, true)
}
