import { Array as Arr, Option, Order, String as Str } from "effect"
import { matchAllIndexed, replaceWith } from "@maple/strings"
import {
	fixUnknownIdentifier,
	identifierText,
	type IdentifierRewrite,
	referencedTables,
	unknownIdentifierName,
} from "./sql-identifiers"

// Server-side fixes for the run_sql mistakes agents repeat most (prod MCP traces, 2026-11).
// Each one is unambiguous or returns undefined; the gate still validates whatever runs.

export interface SqlFix {
	readonly sql: string
	readonly rewrites: ReadonlyArray<IdentifierRewrite>
}

interface Edit {
	readonly start: number
	readonly end: number
	readonly text: string
}

const applyEdits = (sql: string, edits: ReadonlyArray<Edit>): string =>
	Arr.reduceRight(
		Arr.sort(
			edits,
			Order.mapInput(Order.Number, (e: Edit) => e.start),
		),
		sql,
		(text, { start, end, text: replacement }) =>
			`${Str.slice(0, start)(text)}${replacement}${Str.slice(end)(text)}`,
	)

const hasColumn = (sql: string, column: string) =>
	Arr.some(referencedTables(sql), (t) => Arr.some(t.columns, (c) => c.name === column))

/** Tables read by the query that have `column`; a fix needs exactly one. */
const ownersOf = (sql: string, column: string) =>
	Arr.filter(referencedTables(sql), (t) => Arr.some(t.columns, (c) => c.name === column)).length

/** OTel attribute keys that rollups and `trace_list_mv` store as their own column. */
const FLAT_COLUMNS: ReadonlyMap<string, string> = new Map([
	["http.route", "HttpRoute"],
	["http.request.method", "HttpMethod"],
	["http.method", "HttpMethod"],
	["http.response.status_code", "HttpStatusCode"],
	["http.status_code", "HttpStatusCode"],
	["deployment.environment", "DeploymentEnv"],
	["deployment.environment.name", "DeploymentEnv"],
	["service.name", "ServiceName"],
	["service.namespace", "ServiceNamespace"],
	["service.version", "ServiceVersion"],
	["vcs.ref.head.revision", "CommitSha"],
	["exception.type", "ExceptionType"],
	["exception.message", "ExceptionMessage"],
	["exception.stacktrace", "ExceptionStacktrace"],
	["error.type", "ErrorType"],
	["user.id", "UserId"],
	["session.id", "SessionId"],
])

const MAP_COLUMNS = new Set(["SpanAttributes", "ResourceAttributes", "LogAttributes", "Attributes"])

/**
 * `SpanAttributes['http.route']` on a table without attribute maps (`trace_list_mv`,
 * `error_events`, the rollups), rewritten to the column that table extracted it into.
 */
const flatColumnForMapRead = (sql: string, message: string): SqlFix | undefined => {
	const written = unknownIdentifierName(message)
	const map = written === undefined ? undefined : Arr.lastNonEmpty(Str.split(".")(written))
	if (map === undefined || !MAP_COLUMNS.has(map) || hasColumn(sql, map)) return undefined
	const masked = identifierText(sql)
	const reads = Arr.filter(
		matchAllIndexed(
			sql,
			new RegExp(`(?<![\\w.])((?:[A-Za-z_]\\w*\\.)?)${map}\\s*\\[\\s*'([^']*)'\\s*\\]`, "g"),
		),
		// The map name itself must be code, not text inside a literal or comment.
		(m) => Str.startsWith(map, m.index + (m[1]?.length ?? 0))(masked),
	)
	const unmatched = Arr.filter(
		matchAllIndexed(masked, new RegExp(`(?<![\\w])${map}(?![\\w])`, "g")),
		(m) => !Arr.some(reads, (r) => m.index === r.index + (r[1]?.length ?? 0)),
	)
	if (reads.length === 0 || unmatched.length > 0) return undefined
	const edits = Arr.map(reads, (m) => {
		const column = FLAT_COLUMNS.get(m[2] ?? "")
		return column === undefined || ownersOf(sql, column) !== 1
			? undefined
			: { start: m.index, end: m.index + m[0].length, text: `${m[1] ?? ""}${column}`, from: m[0] }
	})
	if (!Arr.every(edits, (e) => e !== undefined)) return undefined
	return {
		sql: applyEdits(sql, edits),
		rewrites: Arr.dedupeWith(
			Arr.map(edits, (e) => ({ from: e.from, to: e.text })),
			(a, b) => a.from === b.from,
		),
	}
}

/** `trace_list_mv` holds root spans only, so `ParentSpanId = ''` is always true there. */
const rootOnlyParentSpanId = (sql: string, message: string): SqlFix | undefined => {
	const written = unknownIdentifierName(message)
	if (
		written === undefined ||
		Arr.lastNonEmpty(Str.split(".")(written)) !== "ParentSpanId" ||
		hasColumn(sql, "ParentSpanId")
	)
		return undefined
	if (!Arr.some(referencedTables(sql), (t) => t.name === "trace_list_mv")) return undefined
	const masked = identifierText(sql)
	// The literal `''` is blanked in the masked text, so match it on the source at the same offsets.
	const compares = Arr.filter(
		matchAllIndexed(sql, /(?<![\w.])(?:[A-Za-z_]\w*\.)?ParentSpanId\s*(=|!=|<>)\s*''/g),
		(m) => Str.includes("ParentSpanId")(Str.slice(m.index, m.index + m[0].length)(masked)),
	)
	const uses = matchAllIndexed(masked, /(?<![\w])ParentSpanId(?![\w])/g)
	if (compares.length === 0 || uses.length !== compares.length) return undefined
	return {
		sql: applyEdits(
			sql,
			Arr.map(compares, (m) => ({
				start: m.index,
				end: m.index + m[0].length,
				text: m[1] === "=" ? "1 = 1" : "1 = 0",
			})),
		),
		rewrites: [
			{
				from: "ParentSpanId = ''",
				to: "1 = 1",
				reason: "trace_list_mv holds root spans only and has no ParentSpanId",
			},
		],
	}
}

// Keywords ClickHouse will not take as an alias without `AS`: `count() sample FROM` is a syntax error.
const KEYWORD_ALIASES =
	"sample|where|prewhere|final|limit|offset|order|group|having|format|window|qualify|union|except|intersect|join|array|left|right|inner|full|cross|any|all|asof|semi|anti|global|using|on|with|stream|head|paste|only"

/** An implicit alias that is a keyword (`any(Body) sample,`) quoted with `AS`. */
const keywordAlias = (sql: string, message: string): SqlFix | undefined => {
	if (!/syntax error/i.test(message)) return undefined
	const aliases = matchAllIndexed(
		identifierText(sql),
		new RegExp(`([)\\]])(\\s+)(${KEYWORD_ALIASES})(?=\\s*(?:,|\\bFROM\\b))`, "gi"),
	)
	if (aliases.length === 0) return undefined
	return {
		sql: applyEdits(
			sql,
			Arr.map(aliases, (m) => {
				const start = m.index + (m[1]?.length ?? 0)
				return {
					start,
					end: start + (m[2]?.length ?? 0) + (m[3]?.length ?? 0),
					text: ` AS \`${m[3]}\``,
				}
			}),
		),
		rewrites: Arr.map(aliases, (m) => ({
			from: m[3] ?? "",
			to: `AS \`${m[3]}\``,
			reason: "a keyword is an alias only after AS",
		})),
	}
}

/** `SpanAttributes[http.route]`: a dotted map key written without quotes. */
const unquotedMapKey = (sql: string, message: string): SqlFix | undefined => {
	const written = unknownIdentifierName(message)
	if (!/syntax error/i.test(message) && (written === undefined || !Str.includes(".")(written)))
		return undefined
	const keys = matchAllIndexed(
		identifierText(sql),
		/(?<![\w.])((?:[A-Za-z_]\w*\.)?(?:SpanAttributes|ResourceAttributes|LogAttributes|ScopeAttributes|Attributes)\s*\[)\s*([A-Za-z_][\w-]*(?:\.[\w-]+)+)\s*\]/g,
	)
	if (keys.length === 0) return undefined
	return {
		sql: applyEdits(
			sql,
			Arr.map(keys, (m) => ({
				start: m.index,
				end: m.index + m[0].length,
				text: `${m[1] ?? ""}'${m[2]}']`,
			})),
		),
		rewrites: Arr.map(keys, (m) => ({
			from: `[${m[2]}]`,
			to: `['${m[2]}']`,
			reason: "map keys are strings",
		})),
	}
}

const STRING_TYPE = /^(?:LowCardinality\()?String\)?$/

/**
 * `HttpStatusCode >= 500` against a String column (or a map value) fails with "no supertype";
 * the number is meant, so the column is read as one.
 */
const stringNumberCompare = (sql: string, message: string): SqlFix | undefined => {
	if (!/no supertype for types String|NO_COMMON_TYPE/i.test(message)) return undefined
	const stringColumns = new Set(
		Arr.flatMap(referencedTables(sql), (t) =>
			Arr.map(
				Arr.filter(t.columns, (c) => STRING_TYPE.test(c.type)),
				(c) => c.name,
			),
		),
	)
	const masked = identifierText(sql)
	const operand = `((?<![\\w.])(?:[A-Za-z_]\\w*\\.)?([A-Za-z_]\\w*)(?:\\s*\\[\\s*'[^']*'\\s*\\])?)`
	const compares = Arr.filter(
		matchAllIndexed(
			sql,
			new RegExp(
				`${operand}(\\s*(?:>=|<=|!=|<>|=|>|<)\\s*-?\\d+(?:\\.\\d+)?\\b|\\s+BETWEEN\\s+-?\\d+(?:\\.\\d+)?\\s+AND\\s+-?\\d+(?:\\.\\d+)?\\b)`,
				"gi",
			),
		),
		(m) => {
			const name = m[2] ?? ""
			const isMapRead = Str.includes("[")(m[1] ?? "")
			// The column name sits in code, not inside a literal or comment.
			const inCode = Str.includes(name)(Str.slice(m.index, m.index + (m[1]?.length ?? 0))(masked))
			return inCode && (isMapRead ? MAP_COLUMNS.has(name) : stringColumns.has(name))
		},
	)
	if (compares.length === 0) return undefined
	return {
		sql: applyEdits(
			sql,
			Arr.map(compares, (m) => ({
				start: m.index,
				end: m.index + (m[1]?.length ?? 0),
				text: `toFloat64OrNull(${m[1]})`,
			})),
		),
		rewrites: Arr.dedupeWith(
			Arr.map(compares, (m) => ({
				from: m[1] ?? "",
				to: `toFloat64OrNull(${m[1]})`,
				reason: "it is a String, compared to a number",
			})),
			(a, b) => a.from === b.from,
		),
	}
}

/** The SQL fixed for the error the warehouse returned, or undefined when no fix is unambiguous. */
export const fixFromError = (sql: string, message: string): SqlFix | undefined => {
	// First: a bare `Map[a.b]` key reads as an unknown column `a.b`, which a column rename would wrap.
	const key = unquotedMapKey(sql, message)
	if (key !== undefined) return key
	const identifier = fixUnknownIdentifier(sql, message)
	if (identifier !== undefined) return { sql: identifier.sql, rewrites: [identifier.rewrite] }
	return (
		flatColumnForMapRead(sql, message) ??
		rootOnlyParentSpanId(sql, message) ??
		keywordAlias(sql, message) ??
		stringNumberCompare(sql, message)
	)
}

/**
 * `SELECT * FROM <rollup>` returns aggregate states as raw bytes, which no client can read
 * (the managed warehouse once failed the whole response on them). Leave them out up front.
 */
export const guardSelectStar = (sql: string): SqlFix | undefined => {
	const masked = identifierText(sql)
	const star = Option.getOrUndefined(
		Str.match(/^\s*SELECT\s+(\*)\s+FROM\s+(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\b/i)(masked),
	)
	if (star === undefined) return undefined
	const tables = referencedTables(sql)
	const [table, ...others] = tables
	if (table === undefined || others.length > 0 || table.name !== star[2]) return undefined
	const states = Arr.map(
		Arr.filter(table.columns, (c) => Str.startsWith("AggregateFunction(")(c.type)),
		(c) => c.name,
	)
	if (states.length === 0) return undefined
	const at = Str.indexOf("*")(masked)
	if (Option.isNone(at)) return undefined
	const to = `* EXCEPT (${Arr.join(states, ", ")})`
	return {
		sql: applyEdits(sql, [{ start: at.value, end: at.value + 1, text: to }]),
		rewrites: [
			{
				from: "*",
				to,
				reason: `those are aggregate states; read them with -Merge functions (see describe_warehouse_tables ${table.name})`,
			},
		],
	}
}

const CLAUSE_OPEN = /\b(?:WHERE|PREWHERE|HAVING|ON)\b/gi
const CLAUSE_CLOSE =
	/^(?:GROUP|ORDER|LIMIT|HAVING|UNION|EXCEPT|INTERSECT|WINDOW|QUALIFY|SETTINGS|FORMAT|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|ARRAY|WHERE|PREWHERE|SAMPLE)\b/i

/** Where the boolean expression starting at `from` ends: a closing paren or the next clause. */
const clauseEnd = (masked: string, from: number): number => {
	let depth = 0
	for (let i = from; i < masked.length; i++) {
		const c = masked[i]
		if (c === "(") depth++
		else if (c === ")") {
			if (depth === 0) return i
			depth--
		} else if (depth === 0 && /[A-Za-z]/.test(c ?? "") && !/\w/.test(masked[i - 1] ?? "")) {
			if (CLAUSE_CLOSE.test(Str.slice(i)(masked))) return i
		}
	}
	return masked.length
}

const ORG_FILTER = /\$__orgFilter(?:\([A-Za-z_]\w*\))?/g

/** The SQL with comments blanked and literals kept, so a trim never lands inside either. */
const withoutComments = (sql: string): string =>
	replaceWith(sql, /'(?:[^'\\]|\\[\s\S]|'')*'?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, (token) =>
		token[0] === "'" ? token : Str.replace(/[^\n]/g, " ")(token),
	)

/** The index of the `)` that closes the `(` at `open`, or the end of the text. */
const closingParen = (masked: string, open: number): number => {
	let depth = 0
	for (let i = open; i < masked.length; i++) {
		if (masked[i] === "(") depth++
		else if (masked[i] === ")" && --depth === 0) return i
	}
	return masked.length
}

/** `[start, end)` of each parenthesised subquery between `from` and `to`: its own scope. */
const subqueries = (masked: string, from: number, to: number) =>
	Arr.map(
		Arr.filter(
			matchAllIndexed(Str.slice(0, to)(masked), /\(\s*(?:SELECT|WITH)\b/gi),
			(m) => m.index >= from,
		),
		(m) => ({ start: m.index, end: closingParen(masked, m.index) }),
	)

/**
 * `WHERE $__orgFilter AND a OR b` matches `b` in every org, so the gate refuses it. Rewritten
 * as `$__orgFilter AND (<clause with the filter taken out>)`: equal to the clause within the
 * org (substituting true for a predicate that must hold anyway), and what the agent meant.
 * The gate still checks the result like any other query.
 */
export const fixOrgFilterOr = (sql: string): SqlFix | undefined => {
	const masked = identifierText(sql)
	const edits = Arr.flatMap(matchAllIndexed(masked, CLAUSE_OPEN), (open): ReadonlyArray<Edit> => {
		const start = open.index + open[0].length
		const end = clauseEnd(masked, start)
		// Trim on the source with comments blanked: a literal is blank in the masked text.
		const source = Str.slice(start, end)(withoutComments(sql))
		const from = start + (source.length - Str.trimStart(source).length)
		const to = start + Str.trimEnd(Str.replace(/;\s*$/, "")(source)).length
		const nested = subqueries(masked, from, to)
		const filters = Arr.filter(
			matchAllIndexed(Str.slice(0, to)(masked), ORG_FILTER),
			(m) => m.index >= from && !Arr.some(nested, (q) => m.index > q.start && m.index < q.end),
		)
		const [first] = filters
		if (first === undefined || !Arr.every(filters, (m) => m[0] === first[0])) return []
		if (!/\b(?:OR|NOT)\b/i.test(Str.slice(from, to)(masked))) return []
		// Dropping `AND` beside the filter is only safe where nothing binds tighter (`NOT x AND`).
		const loose = /(?:^|\(|\bAND|\bOR)$/i
		const removals = Arr.map(filters, (m): Edit => {
			const left = Str.trimEnd(Str.slice(from, m.index)(masked))
			const right = Str.slice(m.index + m[0].length, to)(masked)
			const after = Option.getOrUndefined(Str.match(/^\s+AND\s+/i)(right))
			if (after !== undefined && loose.test(left))
				return { start: m.index, end: m.index + m[0].length + after[0].length, text: "" }
			const before = Option.getOrUndefined(Str.match(/\s+AND\s+$/i)(Str.slice(from, m.index)(masked)))
			if (before !== undefined && /^\s*(?:$|\)|AND\b|OR\b)/i.test(right))
				return { start: m.index - before[0].length, end: m.index + m[0].length, text: "" }
			return { start: m.index, end: m.index + m[0].length, text: "true" }
		})
		return [
			{ start: from, end: from, text: `${first[0]} AND (` },
			...removals,
			{ start: to, end: to, text: ")" },
		]
	})
	if (edits.length === 0) return undefined
	return {
		sql: applyEdits(sql, edits),
		rewrites: [
			{
				from: "$__orgFilter beside OR/NOT",
				to: "$__orgFilter AND (<the rest of the clause>)",
				reason: "AND binds tighter than OR, so as written the clause matched rows outside the org",
			},
		],
	}
}
