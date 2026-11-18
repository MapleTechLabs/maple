// Pure helpers the Perses and Grafana importers share: lenient readers over
// untrusted JSON, widget ids, placeholder notes and ClickHouse SQL scoping.
import { dashboardTimeBoundIssue } from "@maple/domain/raw-sql"
import { Array as Arr, Option, String as Str } from "effect"
import {
	type DashboardWidgetSchema,
	type RawSqlDisplayType,
	widgetTypeByVisualization,
} from "@maple/domain/http"
import { makeRawSqlDataSource, makeStaticDataSource } from "@maple/widgets/dashboard"

export type UnknownRecord = Record<string, unknown>
export type DashboardWidget = typeof DashboardWidgetSchema.Type

export const isRecord = (value: unknown): value is UnknownRecord =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

export const asRecord = (value: unknown): UnknownRecord | null => (isRecord(value) ? value : null)

export const asArray = (value: unknown): unknown[] => (Arr.isArray(value) ? value : [])

export const asString = (value: unknown): string | undefined =>
	typeof value === "string" && Str.trim(value).length > 0 ? value : undefined

export const asFiniteNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined

const sanitizeIdSegment = (value: string): string => {
	const normalized = Str.replace(/^-+|-+$/g, "")(Str.replace(/[^a-z0-9_-]+/g, "-")(Str.toLowerCase(value)))
	return normalized.length > 0 ? normalized : "panel"
}

/** `<prefix>-<key>`, suffixed `-2`, `-3` until it is not in `existing`; records the id. */
export function uniqueWidgetId(prefix: string, key: string, existing: Set<string>): string {
	const base = `${prefix}-${sanitizeIdSegment(key)}`
	let candidate = base
	let index = 2
	while (existing.has(candidate)) {
		candidate = `${base}-${index++}`
	}
	existing.add(candidate)
	return candidate
}

/**
 * `sql` with the text of its comments and quoted spans blanked to spaces, delimiters kept and
 * length unchanged, so a scan of it sees only code and its indices are the original's.
 */
function codeOnly(sql: string): string {
	// UTF-16 units, as `sql[i]` indexes them (an iterator would split astral characters differently).
	const out = Str.split("")(sql)
	const blank = (from: number, to: number) => {
		for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "
	}
	let quote: string | undefined
	let quoteStart = 0
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i] ?? ""
		if (quote !== undefined) {
			if (ch === "\\") i += 1
			else if (ch === quote) {
				blank(quoteStart, i)
				quote = undefined
			}
			continue
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch
			quoteStart = i + 1
		} else if (ch === "-" && sql[i + 1] === "-") {
			// A line comment runs to the newline.
			const from = i + 2
			while (i < sql.length && sql[i] !== "\n") i += 1
			blank(from, i)
		} else if (ch === "/" && sql[i + 1] === "*") {
			// A block comment runs to its matching close; ClickHouse nests them.
			const from = i + 2
			let comments = 1
			i += 2
			while (i < sql.length && comments > 0) {
				if (sql[i] === "/" && sql[i + 1] === "*") {
					comments += 1
					i += 2
				} else if (sql[i] === "*" && sql[i + 1] === "/") {
					comments -= 1
					i += 2
				} else i += 1
			}
			blank(from, comments === 0 ? i - 2 : i)
			i -= 1
		}
	}
	if (quote !== undefined) blank(quoteStart, sql.length)
	return Arr.join(out, "")
}

const hasOrgFilter = (code: string) => Str.includes("$__orgFilter")(code)

/**
 * Every place `keyword` appears at the top level of `code` (from `codeOnly`), outside parentheses,
 * from index `from` on, as `[start, end]`. A clause inside a subquery is not the outer query's.
 */
function topLevelMatches(code: string, keyword: RegExp, from = 0): Array<readonly [number, number]> {
	const sticky = new RegExp(`(?<![A-Za-z0-9_$])(?:${keyword.source})(?![A-Za-z0-9_])`, "iy")
	const found: Array<readonly [number, number]> = []
	let depth = 0
	for (let i = 0; i < code.length; i++) {
		const ch = code[i]
		if (ch === "(") depth += 1
		else if (ch === ")") depth -= 1
		else if (depth === 0 && i >= from) {
			sticky.lastIndex = i
			const match = sticky.exec(code)
			if (match !== null) found.push([i, i + match[0].length])
		}
	}
	return found
}

const topLevelIndex = (code: string, keyword: RegExp, from = 0): number | undefined =>
	topLevelMatches(code, keyword, from)[0]?.[0]

// Every clause ClickHouse allows after WHERE; the org filter goes before the first of them.
const TRAILING_CLAUSE = /GROUP\s+BY|HAVING|WINDOW|QUALIFY|ORDER\s+BY|LIMIT|OFFSET|FORMAT|SETTINGS/

// What follows a column named like a one-word clause (`format = 'json'`, `limit IN (1)`), never
// the clause. A comment (`--`, `/*`) is not an operator.
const COLUMN_FOLLOWER =
	/^\s*(?:[=<>!,)+*%.:|]|-(?!-)|\/(?!\*)|(?:IN|IS|NOT|LIKE|ILIKE|BETWEEN|AND|OR|AS|GLOBAL)(?![A-Za-z0-9_]))/i

/** The outer query's first trailing clause: after its FROM, and not a column that shares the name. */
function trailingClauseIndex(code: string): number | undefined {
	const fromAt = topLevelIndex(code, /FROM/) ?? 0
	const clause = Arr.findFirst(
		topLevelMatches(code, TRAILING_CLAUSE, fromAt),
		// GROUP BY and ORDER BY are two words, so never a column name.
		([start, end]) =>
			/\s/.test(Str.slice(start, end)(code)) || !COLUMN_FOLLOWER.test(Str.slice(end)(code)),
	)
	return Option.getOrUndefined(Option.map(clause, ([start]) => start))
}

/**
 * The outer query with `$__orgFilter` ANDed onto its WHERE (or a WHERE added), before its first
 * trailing clause. The existing predicate is grouped, so a top-level OR cannot escape the filter,
 * and a terminal semicolon is dropped so the filter stays inside the statement.
 */
function withOrgFilter(sql: string): string {
	const statement = Str.replace(/;\s*$/, "")(Str.trimEnd(sql))
	const code = codeOnly(statement)
	const trailingAt = trailingClauseIndex(code)
	const headEnd = trailingAt ?? statement.length
	const head = Str.trimEnd(Str.slice(0, headEnd)(statement))
	const tail = trailingAt === undefined ? "" : ` ${Str.trimStart(Str.slice(trailingAt)(statement))}`
	const whereAt = topLevelIndex(Str.slice(0, head.length)(code), /WHERE/)
	// A `--` comment runs to the end of its line, so text placed after one starts a new line.
	const endsInComment = (from: number) => Str.includes("--")(Str.slice(from, head.length)(code))
	if (whereAt === undefined) {
		return `${head}${endsInComment(0) ? "\n" : " "}WHERE $__orgFilter${tail}`
	}
	const predicateAt = whereAt + "WHERE".length
	const predicate = Str.trim(Str.slice(predicateAt)(head))
	const close = endsInComment(predicateAt) ? "\n)" : ")"
	return `${Str.slice(0, predicateAt)(head)} (${predicate}${close} AND $__orgFilter${tail}`
}

// Whitespace and the (blanked) comments `codeOnly` leaves between two tokens.
const GAP = String.raw`(?:\s|/\*\s*\*/|--[^\n]*(?:\n|$))*`

// A UNION, INTERSECT or EXCEPT joins statements that each need their own scope. `SELECT * EXCEPT (col)`
// is ClickHouse's column exclusion, not a set operation, so EXCEPT counts only before a SELECT.
const SET_OPERATION = new RegExp(
	String.raw`UNION|INTERSECT|EXCEPT(?=${GAP}(?:(?:ALL|DISTINCT)(?![A-Za-z0-9_])${GAP})?\(?${GAP}SELECT(?![A-Za-z0-9_]))`,
)

// A table join; `ARRAY JOIN` unrolls a column of the same rows and reads no other table.
const TABLE_JOIN = /(?<!ARRAY\s+(?:LEFT\s+)?)JOIN/

/** The SELECTs a top-level set operation combines, as slices of `code`; one when there is none. */
const combinedSelects = (code: string): string[] => {
	const bounds = topLevelMatches(code, SET_OPERATION)
	const starts = [0, ...Arr.map(bounds, ([, end]) => end)]
	return Arr.map(starts, (start, i) => Str.slice(start, bounds[i]?.[0] ?? code.length)(code))
}

export type NormalizedSql = { readonly sql: string } | { readonly placeholderReason: string }

/** Org-scopes an imported ClickHouse query, or explains why it must stay a placeholder. */
export function normalizeClickHouseSql(sql: string, warnings: string[], panelTitle: string): NormalizedSql {
	// Comments and literals cannot scope a query: `-- $__orgFilter` filters nothing.
	const code = codeOnly(sql)
	if (!hasOrgFilter(code) && !/\bOrgId\b/.test(code)) {
		warnings.push(
			`Panel "${panelTitle}" was imported as a placeholder because its ClickHouse query does not include $__orgFilter or an OrgId predicate.`,
		)
		return { placeholderReason: "This ClickHouse query needs Maple org scoping before it can run." }
	}

	const selects = combinedSelects(code)
	if (selects.length > 1 && !Arr.every(selects, hasOrgFilter)) {
		warnings.push(
			`Panel "${panelTitle}" was imported as a placeholder because its ClickHouse query combines several SELECTs; add $__orgFilter to each.`,
		)
		return {
			placeholderReason: "This ClickHouse query needs $__orgFilter in each of its SELECTs before it can run.",
		}
	}

	const fromAt = topLevelIndex(code, /FROM/)
	// The outer query reads a subquery: its rows may have no OrgId column to filter, so the scope
	// has to be written inside it by hand.
	const readsSubquery = fromAt !== undefined && /^FROM\s*\(/i.test(Str.slice(fromAt)(code))
	if (!hasOrgFilter(code) && readsSubquery) {
		warnings.push(
			`Panel "${panelTitle}" was imported as a placeholder because its ClickHouse query reads a subquery; add $__orgFilter inside it.`,
		)
		return {
			placeholderReason: "This ClickHouse query needs $__orgFilter inside its subquery before it can run.",
		}
	}

	// One OrgId predicate scopes one table; Maple's filter goes on the outer WHERE only.
	if (!hasOrgFilter(code) && topLevelIndex(code, TABLE_JOIN) !== undefined) {
		warnings.push(
			`Panel "${panelTitle}" was imported as a placeholder because its ClickHouse query joins tables; add $__orgFilter for each of them.`,
		)
		return {
			placeholderReason: "This ClickHouse query needs $__orgFilter for each table it joins before it can run.",
		}
	}

	const normalized = hasOrgFilter(code) ? sql : withOrgFilter(sql)

	if (!hasOrgFilter(code)) {
		warnings.push(
			`Panel "${panelTitle}" had an explicit OrgId reference; Maple added $__orgFilter so the widget stays tenant-scoped.`,
		)
	}

	// Saving refuses raw SQL that reads outside the dashboard range (DashboardPersistenceService).
	if (dashboardTimeBoundIssue(normalized) !== null) {
		warnings.push(
			`Panel "${panelTitle}" was imported as a placeholder because its ClickHouse query does not use $__timeFilter(...) or $__startTime, so it would read all retained data on every refresh.`,
		)
		return {
			placeholderReason:
				"This ClickHouse query needs a Maple time filter ($__timeFilter(...) or $__startTime) before it can run.",
		}
	}

	return { sql: normalized }
}

/** A scalar panel (or a `stat` display type) reduces the rows to the first `value`. */
export function scalarTransform(visualization: string, displayType: string) {
	const isScalar = displayType === "stat" || widgetTypeByVisualization(visualization)?.isScalar === true
	return isScalar ? { reduceToValue: { field: "value", aggregate: "first" as const } } : undefined
}

export function rawSqlDataSource(args: {
	visualization: string
	sql: string
	displayType: RawSqlDisplayType
	/** A scalar's reducer from the source dashboard; the default reads the first row. */
	transform?:
		| ReturnType<typeof scalarTransform>
		| {
				readonly reduceToValue: {
					readonly field: string
					readonly aggregate: "first" | "avg" | "max" | "min" | "sum" | "count"
				}
		  }
}): DashboardWidget["dataSource"] {
	const transform = args.transform ?? scalarTransform(args.visualization, args.displayType)
	return makeRawSqlDataSource({
		sql: args.sql,
		displayType: args.displayType,
		...(transform ? { transform } : undefined),
	})
}

/** A markdown note: a text panel, or a placeholder for one the importer cannot run. */
export function markdownWidget(args: {
	id: string
	title: string
	description?: string | undefined
	content: string
	layout: DashboardWidget["layout"]
}): DashboardWidget {
	return {
		id: args.id,
		visualization: "markdown",
		dataSource: makeStaticDataSource(),
		display: {
			title: args.title,
			...(args.description ? { description: args.description } : undefined),
			markdown: { content: args.content },
		},
		layout: args.layout,
	}
}

/** A note naming what the source panel was and the queries it held, so nothing is lost silently. */
export function placeholderWidget(args: {
	source: "Perses" | "Grafana"
	id: string
	title: string
	description?: string | undefined
	layout: DashboardWidget["layout"]
	reason: string
	/** e.g. ["Panel plugin", "TimeSeriesChart"]. */
	panelKind?: readonly [label: string, kind: string]
	querySummaries?: readonly string[]
}): DashboardWidget {
	const lines = [
		`### ${args.source} import placeholder`,
		args.reason,
		...(args.panelKind ? [`${args.panelKind[0]}: \`${args.panelKind[1]}\``] : []),
		...(args.querySummaries && args.querySummaries.length > 0
			? ["", "Queries:", ...Arr.map(args.querySummaries, (summary) => `- ${summary}`)]
			: []),
	]
	return markdownWidget({ ...args, content: Arr.join(lines, "\n") })
}
