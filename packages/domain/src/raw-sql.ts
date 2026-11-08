import { Option, Schema, Array as Arr, String as Str } from "effect"
import { maskLiteralsAndComments } from "@maple-dev/effect-orm/sql"

/** Blanks literals and comments, keeping positions, so text searches only see SQL. */
export { maskLiteralsAndComments }

// The static half of raw-SQL validation: everything that can be decided from the
// query text alone, without an org, a time window, or a granularity.
//
// It lives here rather than in the query engine because the same rules have to
// be applied by every surface that accepts user SQL — the execute route, the MCP
// widget tools, the dashboard and alert editors — and each one that reimplements
// a subset of them accepts queries the others reject. Macro *expansion* stays in
// `prepareRawSql`, which is the only caller with the runtime values to do it.

export const MAX_RAW_SQL_LENGTH = 32_768
export const MAX_RAW_SQL_RESULT_ROWS = 1_000
export const MAX_RAW_SQL_RESULT_BYTES = 5_000_000
export const MAX_RAW_SQL_CELL_LENGTH = 64_000
export const MAX_RAW_SQL_ALERT_GROUPS = 100
export const MAX_RAW_SQL_GROUP_KEY_LENGTH = 256

/**
 * What a raw query is being validated for. `dashboard` is authoring a widget and
 * `alert` a rule: both rerun unattended, so both must bound their time range.
 * `interactive` is one-off execution (run_sql, and widgets saved before the rule).
 */
export type RawSqlWorkload = "interactive" | "dashboard" | "alert"

export type RawSqlIssueCode =
	| "MissingOrgFilter"
	| "InvalidMacro"
	| "DisallowedStatement"
	| "DisallowedFunction"
	| "MultipleStatements"
	| "UnresolvedMacro"
	| "ResourceLimit"

export interface RawSqlIssue {
	readonly code: RawSqlIssueCode
	readonly message: string
}

/** Macro argument: a column identifier, optionally table-qualified. */
const COLUMN_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/

const DENY_LIST = [
	"INSERT",
	"UPDATE",
	"DELETE",
	"DROP",
	"ALTER",
	"TRUNCATE",
	"RENAME",
	"ATTACH",
	"DETACH",
	"CREATE",
	"GRANT",
	"REVOKE",
	"OPTIMIZE",
	"KILL",
] as const

const DENY_LIST_RE = new RegExp(`\\b(${Arr.join(DENY_LIST, "|")})\\b`, "i")

/**
 * `INTO OUTFILE` is a SELECT terminal clause, so it slips past the deny list's
 * statement-keyword check while asking the server to write a file.
 */
const INTO_OUTFILE_RE = /\bINTO\s+OUTFILE\b/i

/**
 * Table functions that read only generated, in-memory data and reach nothing
 * outside the query, so they are the one call form allowed in a table position.
 *
 * Everything else written as `name(...)` after FROM/JOIN reaches outside this
 * warehouse: `url`, `s3`, `remote`, `file`, `mysql`, `loop`, `view`, and the
 * many lake-format and object-store readers ClickHouse keeps adding. On BYO and
 * self-hosted clusters that is a working SSRF/file-read primitive with the
 * response handed back as rows, untouched by per-org credentials or the row cap.
 *
 * An allow list is the only shape that cannot go stale: a new reader family is
 * refused the day it lands, with no regex to keep in step. The check runs over a
 * token stream (comments stripped, strings and quoted identifiers lexed as the
 * server lexes them), so a quoted, commented, cased or Unicode-quoted spelling
 * of a blocked name resolves to the same token and is refused all the same.
 */
const ALLOWED_TABLE_FUNCTIONS = new Set(["numbers", "generateseries"])

// Defense in depth: known readers are refused as a call in ANY position, so a
// table position the walker misses still cannot reach them. Families are
// prefixes (ClickHouse suffixes them: `icebergS3Cluster`); the rest are exact
// because they prefix real scalars (`URLHash`, `hiveHash`, `generateRandomStructure`).
// `file` is also a scalar, and it reads the server's files, so it stays here.
const READER_PREFIXES = [
	"iceberg",
	"deltalake",
	"hudi",
	"paimon",
	"s3",
	"cosn",
	"oss",
	"gcs",
	"azureblobstorage",
	"hdfs",
	"remote",
	"cluster",
	"mysql",
	"postgresql",
	"mongodb",
	"redis",
	"sqlite",
	"odbc",
	"jdbc",
	"executable",
	"arrowflight",
	"ytsaurus",
	"mergetree",
]
const READER_NAMES = new Set([
	"url",
	"urlcluster",
	"file",
	"filecluster",
	"input",
	"dictionary",
	"hive",
	"merge",
	"loop",
	"view",
	"generaterandom",
	"timeseriesdata",
	"timeseriesmetrics",
	"timeseriestags",
	"primes",
	"filesystem",
	"eval",
	"arrowstream",
	"prometheusquery",
	"prometheusqueryrange",
	"timeseriessamples",
	"timeseriesselector",
	"viewexplain",
	"viewifpermitted",
	"fuzzjson",
	"fuzzquery",
])
const isReaderName = (name: string): boolean =>
	READER_NAMES.has(name) || Arr.some(READER_PREFIXES, (prefix) => Str.startsWith(prefix)(name))

interface SqlToken {
	readonly v: string
	readonly ident: boolean
}

const IDENT_START_RE = /[A-Za-z_]/
const IDENT_PART_RE = /[A-Za-z0-9_]/
// Identifier quotes, including the Unicode double quotes ClickHouse accepts.
const QUOTE_CLOSE = new Map([
	["`", "`"],
	['"', '"'],
	["“", "”"],
])
const SPACE_RE = /\s/
const HEX2_RE = /^[0-9A-Fa-f]{2}$/
// ClickHouse decodes these escapes in a quoted identifier; any other `\c` keeps its backslash.
const IDENT_ESCAPES = new Map([
	["\\", "\\"],
	["'", "'"],
	['"', '"'],
	["`", "`"],
	["/", "/"],
	["=", "="],
	["b", "\b"],
	["f", "\f"],
	["n", "\n"],
	["r", "\r"],
	["t", "\t"],
	["0", "\0"],
	["a", "\x07"],
	["v", "\v"],
	["e", "\x1b"],
])

/** The character at `index`, or `""` past either end. */
const charAt = (text: string, index: number): string => Option.getOrElse(Str.charAt(text, index), () => "")

/** Where `search` first occurs at or after `from`, or -1. */
const indexFrom = (text: string, search: string, from: number): number =>
	Option.match(Str.indexOf(search)(Str.slice(from)(text)), {
		onNone: () => -1,
		onSome: (offset) => from + offset,
	})

/**
 * ClickHouse SQL as significant tokens: whitespace, `--`/`#`/`/* *\/` comments and
 * string literals dropped; identifiers (quoted or bare) lowercased; every other
 * character its own single-char token so a `(`'s left neighbour is always known.
 * A pure lexer, so it uses local indices rather than Effect primitives.
 */
const tokenizeSql = (sql: string): ReadonlyArray<SqlToken> => {
	const tokens: Array<SqlToken> = []
	const n = sql.length
	let i = 0
	while (i < n) {
		const c = charAt(sql, i)
		if (SPACE_RE.test(c)) {
			i++
		} else if ((c === "-" && charAt(sql, i + 1) === "-") || c === "#") {
			const nl = indexFrom(sql, "\n", i)
			i = nl === -1 ? n : nl
		} else if (c === "/" && charAt(sql, i + 1) === "*") {
			const end = indexFrom(sql, "*/", i + 2)
			i = end === -1 ? n : end + 2
		} else if (c === "'") {
			i++
			while (i < n) {
				const d = charAt(sql, i)
				if (d === "\\") {
					i += 2
				} else if (d === "'" && charAt(sql, i + 1) === "'") {
					// A doubled quote escapes itself.
					i += 2
				} else if (d === "'") {
					i++
					break
				} else {
					i++
				}
			}
		} else if (QUOTE_CLOSE.has(c)) {
			const close = QUOTE_CLOSE.get(c) ?? c
			i++
			let body = ""
			while (i < n) {
				const d = charAt(sql, i)
				if (d === "\\") {
					// Decoded as the server does, so `\x73ystem` and `sys\Ntem` both read as `system`.
					const e = charAt(sql, i + 1)
					const hex = Str.slice(i + 2, i + 4)(sql)
					if ((e === "x" || e === "X") && HEX2_RE.test(hex)) {
						body += String.fromCharCode(Number.parseInt(hex, 16))
						i += 4
					} else {
						body += e === "N" ? "" : (IDENT_ESCAPES.get(e) ?? `\\${e}`)
						i += 2
					}
				} else if (d === close) {
					if (close !== "”" && charAt(sql, i + 1) === close) {
						body += d
						i += 2
					} else {
						i++
						break
					}
				} else {
					body += d
					i++
				}
			}
			tokens.push({ v: Str.toLowerCase(body), ident: true })
		} else if (IDENT_START_RE.test(c)) {
			let j = i + 1
			while (j < n && IDENT_PART_RE.test(charAt(sql, j))) j++
			tokens.push({ v: Str.toLowerCase(Str.slice(i, j)(sql)), ident: true })
			i = j
		} else {
			tokens.push({ v: c, ident: false })
			i++
		}
	}
	return tokens
}

// Keywords that end the FROM list, so a later comma no longer introduces a table.
// FINAL, SAMPLE, ON and USING qualify one item; a comma after them is a new table.
const CLAUSE_BOUNDARY = new Set([
	"where",
	"prewhere",
	"group",
	"order",
	"having",
	"limit",
	"offset",
	"settings",
	"union",
	"except",
	"intersect",
	"window",
	"qualify",
	"format",
	"into",
	"select",
	"with",
])

/**
 * The first disallowed table function, or null. Any known reader called anywhere
 * is refused. Beyond that, a table source is a token right after FROM/JOIN, a
 * comma in the FROM list, or a `(` in either position; when it is
 * an identifier immediately followed by `(` it is a table function, and only the
 * in-memory generators are allowed. `FROM (SELECT ...)` is a subquery, a bare
 * `FROM traces` a table, and `urlHash(...)` or `EXTRACT(x FROM y)` sit in an
 * expression (inside a call paren), never in a table position.
 */
export const disallowedTableFunction = (sql: string): string | null => {
	const tokens = tokenizeSql(sql)
	const parenKind: Array<"call" | "sub" | "group"> = []
	// The enclosing FROM list survives a paren: a subquery closing must not end it.
	const outerFromList: Array<number> = []
	let depth = 0
	let armed = false
	let fromListDepth = -1
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]
		if (t === undefined) continue
		if (!t.ident) {
			if (t.v === "(") {
				const prev = tokens[i - 1]
				const next = tokens[i + 1]
				// FROM-first queries (`(FROM t SELECT ...)`) are subqueries too.
				const sub =
					next?.ident === true && (next.v === "select" || next.v === "with" || next.v === "from")
				const call = prev?.ident === true && prev.v !== "in" && !armed
				parenKind.push(sub ? "sub" : call ? "call" : "group")
				depth++
				outerFromList.push(fromListDepth)
				// A subquery opens its own FROM list; `FROM (x(...))` keeps the table position.
				if (sub) armed = false
			} else if (t.v === ")") {
				parenKind.pop()
				depth--
				fromListDepth = outerFromList.pop() ?? -1
				armed = false
			} else if (t.v === "," && depth === fromListDepth) {
				armed = true
			} else {
				armed = false
			}
			continue
		}
		const after = tokens[i + 1]
		if (after !== undefined && !after.ident && after.v === "(" && isReaderName(t.v)) return t.v
		if (t.v === "from" || (t.v === "join" && (tokens[i - 1]?.v ?? "") !== "array")) {
			if (parenKind[parenKind.length - 1] !== "call") {
				armed = true
				fromListDepth = depth
			}
			continue
		}
		// ARRAY JOIN takes array expressions; its commas do not introduce tables.
		if (t.v === "join" && depth === fromListDepth) {
			fromListDepth = -1
			continue
		}
		if (armed) {
			let j = i
			let dotted = false
			while (tokens[j + 1]?.v === "." && tokens[j + 2]?.ident === true) {
				j += 2
				dotted = true
			}
			const next = tokens[j + 1]
			if (
				next !== undefined &&
				!next.ident &&
				next.v === "(" &&
				(dotted || !ALLOWED_TABLE_FUNCTIONS.has(t.v))
			) {
				return dotted
					? Arr.join(
							Arr.map(tokens.slice(i, j + 1), (x) => x.v),
							"",
						)
					: t.v
			}
			armed = false
			i = j
			continue
		}
		// `AS limit` and `a.limit` name an alias or column; they do not end the FROM list.
		const prev = tokens[i - 1]?.v
		if (CLAUSE_BOUNDARY.has(t.v) && depth === fromListDepth && prev !== "as" && prev !== ".")
			fromListDepth = -1
	}
	return null
}

// Scalars that read dictionaries, other tables, server settings, accounts or the binary.
// Prefixes cover families (`dictGetString`, `getSettingOrDefault`, `joinGetOrNull`).
const SERVER_READER_PREFIXES = [
	"dictget",
	"dicthas",
	"dictis",
	"joinget",
	"getsetting",
	"getserversetting",
	"getmergetreesetting",
	"getmaxtablenamelength",
	"addressto",
]
const SERVER_READER_NAMES = new Set([
	"hascolumnintable",
	"getmacro",
	"getclienthttpheader",
	"getserverport",
	"getoskernelversion",
	"showcertificate",
	"catboostevaluate",
	"naivebayesclassifier",
	"demangle",
	"logtrace",
	"currentuser",
	"user",
	"session_user",
	"currentroles",
	"enabledroles",
	"defaultroles",
	"currentprofiles",
	"enabledprofiles",
	"defaultprofiles",
])

/** The first server-reading scalar called anywhere, or null; quoting and comments do not hide it. */
const disallowedServerFunction = (sql: string): string | null => {
	const tokens = tokenizeSql(sql)
	const hit = Arr.findFirst(tokens, (t, i) => {
		const next = tokens[i + 1]
		return (
			t.ident &&
			next !== undefined &&
			!next.ident &&
			next.v === "(" &&
			(SERVER_READER_NAMES.has(t.v) ||
				Arr.some(SERVER_READER_PREFIXES, (prefix) => Str.startsWith(prefix)(t.v)))
		)
	})
	return Option.getOrNull(Option.map(hit, (t) => t.v))
}

// Databases whose tables describe the whole server rather than this org's data.
const SYSTEM_DATABASES = new Set(["system", "information_schema"])

/**
 * The first system database used as a `db.` qualifier, or null. Runs on the token
 * stream, so quoted, Unicode-quoted, escaped, cased and commented spellings all match,
 * while a bare `system` column or alias (no qualifier dot) and string literals pass.
 */
const systemDatabaseReference = (sql: string): string | null => {
	const tokens = tokenizeSql(sql)
	const isDot = (t: SqlToken | undefined) => t !== undefined && !t.ident && t.v === "."
	const hit = Arr.findFirst(
		tokens,
		(t, i) => t.ident && SYSTEM_DATABASES.has(t.v) && isDot(tokens[i + 1]) && !isDot(tokens[i - 1]),
	)
	return Option.getOrNull(Option.map(hit, (t) => t.v))
}

/**
 * ClickHouse syntax the masker does not lex: `#` / `#!` line comments, `$$` and
 * `$tag$` heredoc strings, and nested block comments (the masker ends a comment at
 * the first close, leaving the outer one's `*\/` behind). Where these appear the
 * masked text and the server disagree on what is code, so every check is moot.
 */
const UNMASKED_SYNTAX: ReadonlyArray<readonly [RegExp, string]> = [
	[/#/, "'#' comments are not supported in raw SQL. Use -- or /* */ comments."],
	[
		/\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/,
		"Heredoc strings ($$...$$ or $tag$...$tag$) are not supported in raw SQL. Use single-quoted strings.",
	],
	[
		/\*\//,
		"Nested /* */ comments are not supported in raw SQL. Close each comment before opening another.",
	],
]

/** Macros the engine expands. Anything else `$__`-shaped is a typo. */
export const RAW_SQL_MACROS = [
	"$__orgFilter",
	"$__timeFilter",
	"$__timeGroup",
	"$__startTime",
	"$__endTime",
	"$__interval_s",
] as const

const SUPPORTED_MACROS_HELP =
	"Supported: $__orgFilter, $__orgFilter(alias), $__timeFilter(col), $__timeGroup(col), $__startTime, $__endTime, $__interval_s."

/** `$__orgFilter` or `$__orgFilter(alias)`; the alias qualifies `OrgId` for joins. */
export const ORG_FILTER_MACRO_RE = /\$__orgFilter(?:\(([^)]*)\))?/g

const TABLE_ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const issue = (code: RawSqlIssueCode, message: string): RawSqlIssue => ({ code, message })

// Clause keywords that bound the boolean expression an org filter sits in.
const CLAUSE_START_RE = /\b(?:SELECT|WHERE|PREWHERE|HAVING|ON|WHEN|THEN|ELSE|QUALIFY|USING)\b|,/gi
const CLAUSE_END_RE =
	/\b(?:GROUP|ORDER|LIMIT|HAVING|UNION|EXCEPT|INTERSECT|WINDOW|QUALIFY|SETTINGS|FORMAT|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|ARRAY|WHERE|PREWHERE|WHEN|THEN|ELSE|END|FROM|SAMPLE)\b|,/i
const BOOLEAN_KEYWORD_RE = /\b(?:AND|OR|NOT|WHERE|PREWHERE|ON|HAVING|WHEN|THEN|ELSE|SELECT|IN)\s*$/i

/** `text[lo, hi)` with every nested parenthesised group blanked, offsets preserved. */
const flattenGroups = (text: string, lo: number, hi: number): string => {
	let out = ""
	let depth = 0
	for (let i = lo; i < hi; i++) {
		const c = charAt(text, i)
		if (c === "(") depth++
		else if (c === ")") depth--
		out += c === "(" || c === ")" || depth > 0 ? " " : c
	}
	return out
}

/** The unmatched parens around `[from, to)`: -1 / length when there are none. */
const enclosingGroup = (text: string, from: number, to: number) => {
	let depth = 0
	let open = -1
	for (let i = from - 1; i >= 0; i--) {
		const c = charAt(text, i)
		if (c === ")") depth++
		else if (c === "(" && depth-- === 0) {
			open = i
			break
		}
	}
	depth = 0
	let close = text.length
	for (let i = to; i < text.length; i++) {
		const c = charAt(text, i)
		if (c === "(") depth++
		else if (c === ")" && depth-- === 0) {
			close = i
			break
		}
	}
	return { open, close }
}

/**
 * Whether the org filter at `[start, end)` of the masked text can be bypassed by a
 * sibling `OR` (AND binds tighter, so `$__orgFilter AND a OR b` matches `b` in any
 * org) or negated by a `NOT`. Climbs through plain parenthesised groups and stops at
 * a clause keyword (a subquery's WHERE is its own scope); any function call escapes.
 */
const orgFilterEscapes = (masked: string, start: number, end: number): boolean => {
	let atomStart = start
	let atomEnd = end
	for (;;) {
		const { open, close } = enclosingGroup(masked, atomStart, atomEnd)
		const lo = open + 1
		const flat = flattenGroups(masked, lo, close)
		const left = Str.slice(0, atomStart - lo)(flat)
		const right = Str.slice(atomEnd - lo)(flat)
		const starts = Arr.fromIterable(Str.matchAll(CLAUSE_START_RE)(left))
		const lastStart = starts.at(-1)
		const leftClause =
			lastStart === undefined ? left : Str.slice((lastStart.index ?? 0) + lastStart[0].length)(left)
		const endMatch = Option.getOrNull(Str.match(CLAUSE_END_RE)(right))
		const rightClause = endMatch?.index === undefined ? right : Str.slice(0, endMatch.index)(right)
		if (/\bOR\b/i.test(leftClause) || /\bOR\b/i.test(rightClause) || /\bNOT\s*$/i.test(leftClause)) {
			return true
		}
		// Any call form (`coalesce(...)`, `if(...)`, `not(...)`) can turn the predicate
		// inert, so only plain grouping parens are climbed. Commas separate its
		// arguments; a clause keyword means a subquery, which is its own scope.
		const keywordBound =
			(lastStart !== undefined && lastStart[0] !== ",") || (endMatch !== null && endMatch[0] !== ",")
		const before = Str.slice(0, Math.max(open, 0))(masked)
		const isCall = open >= 0 && /[A-Za-z0-9_]\s*$/.test(before) && !BOOLEAN_KEYWORD_RE.test(before)
		if (!keywordBound && isCall) return true
		if (lastStart !== undefined || endMatch !== null || open < 0) return false
		atomStart = open
		atomEnd = close + 1
	}
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*"
// A clause word after a table is never its alias: `FROM traces JOIN logs l` must still bind `l`.
const NOT_ALIAS =
	"(?!(?:WHERE|PREWHERE|FINAL|SAMPLE|ARRAY|GLOBAL|ANY|ALL|INNER|LEFT|RIGHT|FULL|CROSS|OUTER|SEMI|ANTI|ASOF|JOIN|ON|USING|GROUP|ORDER|LIMIT|UNION|SETTINGS|FORMAT)\\b)"
const escapeRe = (s: string) => Str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")(s)

/**
 * Whether `alias` names a real table read in a FROM/JOIN (`FROM traces t`, `JOIN db.logs AS l`,
 * or the bare table name). A subquery, table function or CTE could be a constant `OrgId`,
 * which would make the tenant predicate true for every row.
 */
const aliasBindsTable = (masked: string, alias: string): boolean => {
	const ctes = new Set(
		Arr.map(
			Arr.fromIterable(
				Str.matchAll(new RegExp(`(?:\\bWITH|,)\\s*(${IDENT})\\s+AS\\s*\\(`, "gi"))(masked),
			),
			(m) => Str.toLowerCase(m[1] ?? ""),
		),
	)
	const a = escapeRe(alias)
	const binding = new RegExp(
		`\\b(?:FROM|JOIN)\\s+(?:${IDENT}\\.)?(${IDENT})(?:\\s+(?:AS\\s+)?${NOT_ALIAS}(${IDENT}))?(?=[\\s,)]|$)`,
		"gi",
	)
	// `FROM a x, b y` binds every comma-separated table; a subquery or table function item ends the run.
	const commaItem = new RegExp(
		`\\s*,\\s*(?:${IDENT}\\.)?(${IDENT})(?:\\s+(?:AS\\s+)?${NOT_ALIAS}(${IDENT}))?(?=[\\s,)]|$)`,
		"iy",
	)
	const bindings = Arr.flatMap(Arr.fromIterable(Str.matchAll(binding)(masked)), (m) => {
		const items: Array<readonly [string, string | undefined]> = [[m[1] ?? "", m[2]]]
		if (!/^FROM/i.test(m[0])) return items
		commaItem.lastIndex = (m.index ?? 0) + m[0].length
		for (let item = commaItem.exec(masked); item !== null; item = commaItem.exec(masked)) {
			items.push([item[1] ?? "", item[2]])
		}
		return items
	})
	for (const [table, bound] of bindings) {
		const names = bound === undefined ? [table] : [table, bound]
		if (Arr.some(names, (n) => new RegExp(`^${a}$`, "i").test(n)) && !ctes.has(Str.toLowerCase(table))) {
			return true
		}
	}
	return false
}

/** The first org-filter problem in the query, or null. */
const orgFilterIssue = (sql: string, masked: string): RawSqlIssue | null => {
	for (const match of Str.matchAll(ORG_FILTER_MACRO_RE)(sql)) {
		const alias = match[1] === undefined ? undefined : Str.trim(match[1])
		if (alias !== undefined && !TABLE_ALIAS_RE.test(alias)) {
			return issue(
				"InvalidMacro",
				`$__orgFilter argument '${alias}' must be a table alias (letters, digits, underscores).`,
			)
		}
		// Offsets are shared with the masked text; a macro inside a literal or comment is inert.
		if (Str.startsWith("$__orgFilter", match.index)(masked)) {
			if (alias !== undefined && !aliasBindsTable(masked, alias)) {
				return issue(
					"InvalidMacro",
					`$__orgFilter(${alias}) must name a table read in FROM or JOIN (e.g. \`FROM traces t ... $__orgFilter(t)\`), not a subquery, table function or CTE.`,
				)
			}
			if (orgFilterEscapes(masked, match.index ?? 0, (match.index ?? 0) + match[0].length)) {
				return issue(
					"InvalidMacro",
					"$__orgFilter is combined with OR (or negated), so rows outside your org could match. " +
						"Keep it a top-level AND condition and parenthesise the rest: `WHERE $__orgFilter AND (a OR b)`.",
				)
			}
		}
	}
	return null
}

// `$__startTime` counts only as a lower bound: `col >= $__startTime`, `col BETWEEN $__startTime ...`,
// or `$__startTime <= col`. Merely selecting it bounds nothing.
const DASHBOARD_TIME_BOUND_RE = /\$__timeFilter\(|(?:>=?|\bBETWEEN)\s*\$__startTime\b|\$__startTime\s*<=?/i

/**
 * A dashboard widget reruns on every refresh, so its SQL must read only the
 * dashboard's range: `$__timeFilter(col)`, or a lower bound on `$__startTime`.
 * Checked on the masked text, so a macro inside a comment does not count.
 */
export const dashboardTimeBoundIssue = (
	sql: string,
	maskedSql: string = maskLiteralsAndComments(sql),
): RawSqlIssue | null => {
	if (DASHBOARD_TIME_BOUND_RE.test(maskedSql)) return null
	return issue(
		"InvalidMacro",
		DASHBOARD_TIME_BOUND_RE.test(sql)
			? "$__timeFilter(...) must appear in the query itself, not inside a comment or string literal."
			: "Dashboard widgets must reference $__timeFilter(...) (or compare a column directly against $__startTime, e.g. `Timestamp >= $__startTime`) so each refresh reads only the dashboard's time range, e.g. `WHERE $__orgFilter AND $__timeFilter(Timestamp)`.",
	)
}

/**
 * Every check `prepareRawSql` makes that does not need runtime values, in the
 * order it makes them. Returns `null` when the query is acceptable.
 *
 * Runs against the query as written, before macro expansion: the macros expand
 * to literals and comparisons, so they can introduce neither a statement
 * keyword nor a terminal clause, and checking the source text is what lets an
 * editor give the same answer as the server before a query is ever sent.
 */
export const rawSqlIssue = (
	sql: string,
	options: { readonly workload: RawSqlWorkload } = { workload: "interactive" },
): RawSqlIssue | null => {
	if (sql.length === 0 || sql.length > MAX_RAW_SQL_LENGTH) {
		return issue("ResourceLimit", `Raw SQL must contain between 1 and ${MAX_RAW_SQL_LENGTH} characters`)
	}

	// Masking is offset-preserving, so it is safe to compute once here and share
	// with the structural checks further down.
	//
	// The org filter is checked against the *masked* text on purpose: expansion is
	// textual, so a `$__orgFilter` written inside a comment expands to a predicate
	// that is still inside the comment — inert — while a raw `includes` reported
	// the requirement as met. That turned the mandatory tenant predicate into an
	// opt-out. The macro checks below stay on the raw text, which is the stricter
	// input: `prepareRawSql` expands macros wherever they appear, literals
	// included, so a macro hidden in a string still has to be a legal one.
	const maskedSql = maskLiteralsAndComments(sql)
	const unmasked = Arr.findFirst(UNMASKED_SYNTAX, ([pattern]) => pattern.test(maskedSql))
	if (Option.isSome(unmasked)) return issue("DisallowedStatement", unmasked.value[1])
	if (!Str.includes("$__orgFilter")(maskedSql)) {
		return issue(
			"MissingOrgFilter",
			Str.includes("$__orgFilter")(sql)
				? "$__orgFilter must appear in the query itself, not inside a comment or string literal."
				: "SQL must reference $__orgFilter so the query is scoped to your org.",
		)
	}
	// Masked, for the same reason as the org filter: an alert whose only
	// `$__timeFilter(` sits in a comment expands to nothing and then rescans all
	// of history on every evaluation, which is the cost the requirement exists to
	// prevent.
	if (options.workload === "alert" && !Str.includes("$__timeFilter(")(maskedSql)) {
		return issue(
			"InvalidMacro",
			Str.includes("$__timeFilter(")(sql)
				? "$__timeFilter(...) must appear in the query itself, not inside a comment or string literal."
				: "Raw SQL alerts must reference $__timeFilter(...) to bound alert reads.",
		)
	}

	const orgIssue = orgFilterIssue(sql, maskedSql)
	if (orgIssue !== null) return orgIssue

	for (const macro of ["$__timeFilter", "$__timeGroup"] as const) {
		const pattern = new RegExp(`\\${macro}\\(([^)]*)\\)`, "g")
		for (const match of Str.matchAll(pattern)(sql)) {
			const column = Str.trim(match[1] ?? "")
			if (!COLUMN_IDENT_RE.test(column)) {
				return issue(
					"InvalidMacro",
					`${macro} argument '${column}' must be a column identifier (letters, digits, underscores, dots).`,
				)
			}
		}
	}

	const unknownMacro = Arr.findFirst(
		Arr.map(Arr.fromIterable(Str.matchAll(/\$__\w+/g)(sql)), (match) => match[0]),
		(name) => !RAW_SQL_MACROS.includes(name as (typeof RAW_SQL_MACROS)[number]),
	)
	if (Option.isSome(unknownMacro)) {
		return issue("UnresolvedMacro", `Unknown macro ${unknownMacro.value}. ${SUPPORTED_MACROS_HELP}`)
	}

	// A single trailing terminator is one statement, not several — rejecting it as
	// "multiple statements" is a false error on the most common way to end a query.
	let masked = maskedSql
	const terminatorMatch = Option.getOrNull(Str.match(/;\s*$/)(masked))
	if (terminatorMatch?.index !== undefined) masked = Str.slice(0, terminatorMatch.index)(masked)
	if (Str.includes(";")(masked)) {
		return issue("MultipleStatements", "Multiple SQL statements are not allowed. Remove ';' separators.")
	}

	// SYSTEM statements fail the SELECT check below; within a SELECT the keyword only
	// matters as a database name, which the token stream resolves however it is quoted.
	if (systemDatabaseReference(sql) !== null) {
		return issue(
			"DisallowedStatement",
			"System tables and SYSTEM statements are not available in raw SQL. For table and column names use describe_warehouse_tables (the warehouse table catalog).",
		)
	}
	const denyMatch = Option.getOrNull(Str.match(DENY_LIST_RE)(masked))
	if (denyMatch) {
		return issue(
			"DisallowedStatement",
			`Statement keyword '${Str.toUpperCase(denyMatch[1] ?? denyMatch[0])}' is not allowed in raw SQL.`,
		)
	}
	if (INTO_OUTFILE_RE.test(masked)) {
		return issue(
			"DisallowedStatement",
			"INTO OUTFILE is not allowed in raw SQL — results are returned over the API.",
		)
	}
	if (!/^\s*(?:SELECT|WITH)\b/i.test(masked)) {
		return issue(
			"DisallowedStatement",
			"Raw SQL must be a SELECT query (WITH common table expressions are supported).",
		)
	}
	// Runs over the source text (not the masked copy): the tokenizer does its own
	// comment and literal handling, and it recognises the Unicode and quoted
	// identifier spellings the masker leaves as-is.
	const tableFunction = disallowedTableFunction(sql)
	if (tableFunction !== null) {
		return issue(
			"DisallowedFunction",
			isReaderName(tableFunction)
				? `Table function '${tableFunction}' is not allowed in raw SQL: it reads outside Maple's tables.`
				: `Table function '${tableFunction}' is not allowed in raw SQL: \`${tableFunction}(...)\` sits where a table goes (after FROM, JOIN or a comma in the FROM list), where only Maple's own tables may be read. Move an expression out of the FROM list, e.g. into SELECT or ARRAY JOIN.`,
		)
	}
	const serverFunction = disallowedServerFunction(sql)
	if (serverFunction !== null) {
		return issue(
			"DisallowedFunction",
			`Function '${serverFunction}' is not allowed in raw SQL. It reads server configuration or data outside Maple's tables.`,
		)
	}
	// The row cap nests the query, and a `SETTINGS` clause at any depth (a
	// subquery's included) applies to the whole query context, where it would
	// outrank the cost profile's time and memory budget. A trailing FORMAT is
	// dropped rather than rejected (the driver owns the wire format); see `prepareRawSql`.
	if (/\bSETTINGS\b/i.test(masked)) {
		return issue(
			"DisallowedStatement",
			"SETTINGS is managed by Maple — raw queries run under a fixed time and memory budget. Remove the SETTINGS clause.",
		)
	}
	// Last, so a structurally broken query reports that first.
	return options.workload === "dashboard" ? dashboardTimeBoundIssue(sql, maskedSql) : null
}

/** `rawSqlIssue` as a predicate, for editors that only need a yes/no. */
export const isValidRawSql = (sql: string, workload: RawSqlWorkload = "interactive"): boolean =>
	rawSqlIssue(sql, { workload }) === null

/**
 * Raw SQL as a schema, so a boundary that stores user SQL rejects it on the way
 * in rather than when someone renders it. The filter surfaces `rawSqlIssue`'s
 * own message, so a schema rejection reads the same as an execution one.
 *
 * Deliberately not applied to `RawSqlExecuteRequest` or the alert-rule payloads:
 * those already run through `prepareRawSql`, which fails with a coded
 * `RawSqlValidationError`, and a schema rejection would replace that with a
 * generic decode error.
 */
export const RawSqlText = Schema.String.check(
	Schema.makeFilter((sql: string) => rawSqlIssue(sql)?.message ?? true, {
		description: "Maple raw ClickHouse SQL",
	}),
).annotate({
	title: "Raw SQL",
	description: `ClickHouse SELECT with Maple macros. Must reference $__orgFilter. ${SUPPORTED_MACROS_HELP}`,
})

/**
 * Whether an alert query aliases a column `AS samples` (the engine reads that
 * exact, case-sensitive key). Without one every returned row counts as 1 sample,
 * so a minimum sample count gates on buckets, not events.
 */
export const rawAlertSqlSelectsSamples = (sql: string): boolean => {
	// Masking keeps offsets (a quoted alias becomes spaces), so read the alias from the original text.
	for (const match of Str.matchAll(/\bAS\s/gi)(maskLiteralsAndComments(sql))) {
		const alias = Str.trimStart(Str.slice((match.index ?? 0) + match[0].length)(sql))
		if (/^(?:samples|`samples`|"samples")(?![A-Za-z0-9_])/.test(alias)) return true
	}
	return false
}

/** The warning to show when a raw-SQL rule's minimum sample count is likely counting rows. */
export const rawAlertSampleCountWarning = (sql: string, minimumSampleCount: number): string | null =>
	minimumSampleCount > 1 && !rawAlertSqlSelectsSamples(sql)
		? `Minimum sample count ${minimumSampleCount} counts returned rows (one per bucket) because the query has no \`samples\` column. Select an event count as \`samples\` (e.g. \`count() AS samples\`) to gate on volume.`
		: null

export type RawAlertPerformanceHintCode = "no_service_filter" | "body_wildcard_match"

/** A change likely to make an alert query cheaper, pointing at the line it is about. */
export interface RawAlertPerformanceHint {
	readonly code: RawAlertPerformanceHintCode
	readonly message: string
	/** 1-based line of the SQL the hint is about. */
	readonly line: number
}

const lineAt = (sql: string, index: number): number => Str.split("\n")(Str.slice(0, index)(sql)).length

/**
 * Cheap, text-only guesses at what makes an alert query slow. Logs and traces are
 * sorted by service after org and time, so a service filter skips most of the data,
 * and a `Body` wildcard match has to read every log body in the window.
 */
export const rawAlertPerformanceHints = (sql: string): ReadonlyArray<RawAlertPerformanceHint> => {
	const masked = maskLiteralsAndComments(sql)
	const table = /\bFROM\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?(logs|traces)\b/i.exec(masked)
	const tableName = table?.[1] === undefined ? undefined : Str.toLowerCase(table[1])
	const serviceHint: ReadonlyArray<RawAlertPerformanceHint> =
		table !== null && tableName !== undefined && !/\bServiceName\b/.test(masked)
			? [
					{
						code: "no_service_filter",
						message: `Filter ${tableName} on a service, e.g. \`AND ServiceName = 'checkout'\`. Rows are stored by service, so the query skips every other service's data.`,
						line: lineAt(sql, table.index),
					},
				]
			: []
	// Masking keeps offsets, so the pattern's literal is read from the original text.
	const bodyHints = Arr.map(
		Arr.filter(Arr.fromIterable(Str.matchAll(/\bBody\s+(?:NOT\s+)?I?LIKE\b/gi)(masked)), (match) =>
			Str.startsWith("'%")(Str.trimStart(Str.slice((match.index ?? 0) + match[0].length)(sql))),
		).slice(0, 1),
		(match): RawAlertPerformanceHint => ({
			code: "body_wildcard_match",
			message:
				"A `Body` match starting with `%` reads every log body in the window. Match a structured attribute instead, e.g. `LogAttributes['event'] = 'webhook.failed'`, or filter on a service first.",
			line: lineAt(sql, match.index ?? 0),
		}),
	)
	return [...serviceHint, ...bodyHints]
}
