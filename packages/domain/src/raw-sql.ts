import { Schema } from "effect"
import { maskLiteralsAndComments, splitTerminalClauses } from "@maple-dev/effect-clickhouse/sql"

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

/** What a raw query is being validated for. Alerts carry one extra rule. */
export type RawSqlWorkload = "interactive" | "alert"

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
	"SYSTEM",
	"KILL",
] as const

const DENY_LIST_RE = new RegExp(`\\b(${DENY_LIST.join("|")})\\b`, "i")

/**
 * `INTO OUTFILE` is a SELECT terminal clause, so it slips past the deny list's
 * statement-keyword check while asking the server to write a file.
 */
const INTO_OUTFILE_RE = /\bINTO\s+OUTFILE\b/i

/**
 * ClickHouse table functions that read from somewhere other than this warehouse.
 *
 * Everything above this line polices what *kind of statement* a query is; none
 * of it constrains where a SELECT reads from. `SELECT * FROM url('http://…')`
 * is a perfectly well-formed single SELECT, and it makes the ClickHouse server —
 * not the API — issue the request, so per-org credentials and the row cap do not
 * touch it. On BYO and self-hosted clusters that is a working SSRF primitive
 * with the response handed back as rows.
 *
 * A deny list is the wrong shape long-term — only an allow list of Maple's own
 * tables closes the class, which needs a parser. Until then the shape that
 * matters is *prefix* matching, below: ClickHouse suffixes these families freely
 * (`iceberg`, `icebergS3`, `icebergAzure`, `icebergS3Cluster`, `deltaLakeAzure`,
 * `s3Cluster`), so an exact-name list goes stale the moment a variant lands —
 * and goes stale silently, because the check keeps passing. No ClickHouse scalar
 * function begins with any of these, which is what makes the prefix safe.
 */
const DISALLOWED_FUNCTION_PREFIXES = [
	"iceberg",
	"deltaLake",
	"hudi",
	"s3",
	"gcs",
	"azureBlobStorage",
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
	"arrowFlight",
	"ytsaurus",
] as const

/**
 * Names that must match *exactly*, because each is a prefix of a legitimate
 * scalar function: `url` would take `URLHash` and `URLPathHierarchy`, `file`
 * would take `filesystemAvailable`, `hive` would take `hiveHash`, `dictionary`
 * would take nothing today but sits beside the whole `dict*` family.
 */
const DISALLOWED_FUNCTION_NAMES = [
	"url",
	"urlCluster",
	"file",
	"fileCluster",
	"input",
	"dictionary",
	"hive",
] as const

// Anchored on the opening paren so a *column* named `file`, or a scalar function
// like `urlHash`, is untouched — only the call form is a table function. The
// leading `\b` is what keeps the exact names exact: there is no word boundary
// inside `urlHash`, so its `url` prefix is never a match start.
const DISALLOWED_FUNCTION_RE = new RegExp(
	`\\b(${DISALLOWED_FUNCTION_PREFIXES.join("|")})[A-Za-z0-9_]*\\s*\\(|\\b(${DISALLOWED_FUNCTION_NAMES.join("|")})\\s*\\(`,
	"i",
)

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
		const c = text.charAt(i)
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
		const c = text.charAt(i)
		if (c === ")") depth++
		else if (c === "(" && depth-- === 0) {
			open = i
			break
		}
	}
	depth = 0
	let close = text.length
	for (let i = to; i < text.length; i++) {
		const c = text.charAt(i)
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
		const left = flat.slice(0, atomStart - lo)
		const right = flat.slice(atomEnd - lo)
		const starts = [...left.matchAll(CLAUSE_START_RE)]
		const lastStart = starts.at(-1)
		const leftClause = lastStart === undefined ? left : left.slice(lastStart.index + lastStart[0].length)
		const endMatch = right.match(CLAUSE_END_RE)
		const rightClause = endMatch?.index === undefined ? right : right.slice(0, endMatch.index)
		if (/\bOR\b/i.test(leftClause) || /\bOR\b/i.test(rightClause) || /\bNOT\s*$/i.test(leftClause)) {
			return true
		}
		// Any call form (`coalesce(...)`, `if(...)`, `not(...)`) can turn the predicate
		// inert, so only plain grouping parens are climbed. Commas separate its
		// arguments; a clause keyword means a subquery, which is its own scope.
		const keywordBound =
			(lastStart !== undefined && lastStart[0] !== ",") || (endMatch !== null && endMatch[0] !== ",")
		const before = masked.slice(0, Math.max(open, 0))
		const isCall = open >= 0 && /[A-Za-z0-9_]\s*$/.test(before) && !BOOLEAN_KEYWORD_RE.test(before)
		if (!keywordBound && isCall) return true
		if (lastStart !== undefined || endMatch !== null || open < 0) return false
		atomStart = open
		atomEnd = close + 1
	}
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*"
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Whether `alias` names a real table read in a FROM/JOIN (`FROM traces t`, `JOIN db.logs AS l`,
 * or the bare table name). A subquery, table function or CTE could be a constant `OrgId`,
 * which would make the tenant predicate true for every row.
 */
const aliasBindsTable = (masked: string, alias: string): boolean => {
	const ctes = new Set(
		[...masked.matchAll(new RegExp(`(?:\\bWITH|,)\\s*(${IDENT})\\s+AS\\s*\\(`, "gi"))].map((m) =>
			(m[1] ?? "").toLowerCase(),
		),
	)
	const a = escapeRe(alias)
	const binding = new RegExp(
		`\\b(?:FROM|JOIN)\\s+(?:${IDENT}\\.)?(${IDENT})(?:\\s+(?:AS\\s+)?(${IDENT}))?(?=[\\s,)]|$)`,
		"gi",
	)
	// `FROM a x, b y` binds every comma-separated table; a subquery or table function item ends the run.
	const commaItem = new RegExp(
		`\\s*,\\s*(?:${IDENT}\\.)?(${IDENT})(?:\\s+(?:AS\\s+)?(${IDENT}))?(?=[\\s,)]|$)`,
		"iy",
	)
	const bindings = [...masked.matchAll(binding)].flatMap((m) => {
		const items: Array<readonly [string, string | undefined]> = [[m[1] ?? "", m[2]]]
		if (!/^FROM/i.test(m[0])) return items
		commaItem.lastIndex = (m.index ?? 0) + m[0].length
		for (let item = commaItem.exec(masked); item !== null; item = commaItem.exec(masked)) {
			items.push([item[1] ?? "", item[2]])
		}
		return items
	})
	for (const [table, bound] of bindings) {
		const names =
			bound === undefined ||
			/^(?:WHERE|PREWHERE|FINAL|SAMPLE|ARRAY|GLOBAL|ANY|ALL|INNER|LEFT|RIGHT|FULL|CROSS|JOIN|ON|USING|GROUP|ORDER|LIMIT|UNION|SETTINGS|FORMAT)$/i.test(
				bound,
			)
				? [table]
				: [table, bound]
		if (names.some((n) => new RegExp(`^${a}$`, "i").test(n)) && !ctes.has(table.toLowerCase())) {
			return true
		}
	}
	return false
}

/** The first org-filter problem in the query, or null. */
const orgFilterIssue = (sql: string, masked: string): RawSqlIssue | null => {
	for (const match of sql.matchAll(ORG_FILTER_MACRO_RE)) {
		const alias = match[1]?.trim()
		if (alias !== undefined && !TABLE_ALIAS_RE.test(alias)) {
			return issue(
				"InvalidMacro",
				`$__orgFilter argument '${alias}' must be a table alias (letters, digits, underscores).`,
			)
		}
		// Offsets are shared with the masked text; a macro inside a literal or comment is inert.
		if (masked.startsWith("$__orgFilter", match.index)) {
			if (alias !== undefined && !aliasBindsTable(masked, alias)) {
				return issue(
					"InvalidMacro",
					`$__orgFilter(${alias}) must name a table read in FROM or JOIN (e.g. \`FROM traces t ... $__orgFilter(t)\`), not a subquery, table function or CTE.`,
				)
			}
			if (orgFilterEscapes(masked, match.index, match.index + match[0].length)) {
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
	if (!maskedSql.includes("$__orgFilter")) {
		return issue(
			"MissingOrgFilter",
			sql.includes("$__orgFilter")
				? "$__orgFilter must appear in the query itself, not inside a comment or string literal."
				: "SQL must reference $__orgFilter so the query is scoped to your org.",
		)
	}
	// Masked, for the same reason as the org filter: an alert whose only
	// `$__timeFilter(` sits in a comment expands to nothing and then rescans all
	// of history on every evaluation, which is the cost the requirement exists to
	// prevent.
	if (options.workload === "alert" && !maskedSql.includes("$__timeFilter(")) {
		return issue(
			"InvalidMacro",
			sql.includes("$__timeFilter(")
				? "$__timeFilter(...) must appear in the query itself, not inside a comment or string literal."
				: "Raw SQL alerts must reference $__timeFilter(...) to bound alert reads.",
		)
	}

	const orgIssue = orgFilterIssue(sql, maskedSql)
	if (orgIssue !== null) return orgIssue

	for (const macro of ["$__timeFilter", "$__timeGroup"] as const) {
		const pattern = new RegExp(`\\${macro}\\(([^)]*)\\)`, "g")
		for (const match of sql.matchAll(pattern)) {
			const column = match[1].trim()
			if (!COLUMN_IDENT_RE.test(column)) {
				return issue(
					"InvalidMacro",
					`${macro} argument '${column}' must be a column identifier (letters, digits, underscores, dots).`,
				)
			}
		}
	}

	const unknownMacro = [...sql.matchAll(/\$__\w+/g)]
		.map((match) => match[0])
		.find((name) => !RAW_SQL_MACROS.includes(name as (typeof RAW_SQL_MACROS)[number]))
	if (unknownMacro !== undefined) {
		return issue("UnresolvedMacro", `Unknown macro ${unknownMacro}. ${SUPPORTED_MACROS_HELP}`)
	}

	// A single trailing terminator is one statement, not several — rejecting it as
	// "multiple statements" is a false error on the most common way to end a query.
	let masked = maskedSql
	const terminatorMatch = masked.match(/;\s*$/)
	if (terminatorMatch?.index !== undefined) masked = masked.slice(0, terminatorMatch.index)
	if (masked.includes(";")) {
		return issue("MultipleStatements", "Multiple SQL statements are not allowed. Remove ';' separators.")
	}

	const denyMatch = masked.match(DENY_LIST_RE)
	if (denyMatch?.[1].toUpperCase() === "SYSTEM") {
		return issue(
			"DisallowedStatement",
			"System tables and SYSTEM statements are not available in raw SQL. For table and column names use describe_warehouse_tables (the warehouse table catalog).",
		)
	}
	if (denyMatch) {
		return issue(
			"DisallowedStatement",
			`Statement keyword '${denyMatch[1].toUpperCase()}' is not allowed in raw SQL.`,
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
	const functionMatch = masked.match(DISALLOWED_FUNCTION_RE)
	if (functionMatch) {
		return issue(
			"DisallowedFunction",
			`Table function '${functionMatch[1]}' is not allowed in raw SQL — queries may only read Maple's own tables.`,
		)
	}
	// The row cap nests the query, and `SETTINGS` is a statement terminator, so an
	// author-supplied one would end up inside the subquery — where ClickHouse
	// propagates it to the whole query context and it silently outranks the cost
	// profile's time and memory budget. A trailing FORMAT is dropped rather than
	// rejected (the driver owns the wire format); see `prepareRawSql`.
	if (splitTerminalClauses(sql).settings !== undefined) {
		return issue(
			"DisallowedStatement",
			"SETTINGS is managed by Maple — raw queries run under a fixed time and memory budget. Remove the SETTINGS clause.",
		)
	}
	return null
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
	for (const match of maskLiteralsAndComments(sql).matchAll(/\bAS\s/gi)) {
		const alias = sql.slice(match.index + match[0].length).trimStart()
		if (/^(?:samples|`samples`|"samples")(?![A-Za-z0-9_])/.test(alias)) return true
	}
	return false
}

/** The warning to show when a raw-SQL rule's minimum sample count is likely counting rows. */
export const rawAlertSampleCountWarning = (sql: string, minimumSampleCount: number): string | null =>
	minimumSampleCount > 1 && !rawAlertSqlSelectsSamples(sql)
		? `Minimum sample count ${minimumSampleCount} counts returned rows (one per bucket) because the query has no \`samples\` column. Select an event count as \`samples\` (e.g. \`count() AS samples\`) to gate on volume.`
		: null
