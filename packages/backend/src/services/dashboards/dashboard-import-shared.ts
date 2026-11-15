// Pure helpers the Perses and Grafana importers share: lenient readers over
// untrusted JSON, widget ids, placeholder notes and ClickHouse SQL scoping.
import { dashboardTimeBoundIssue } from "@maple/domain/raw-sql"
import { Array as Arr, String as Str } from "effect"
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

function hasOrgScope(sql: string): boolean {
	return Str.includes("$__orgFilter")(sql) || /\bOrgId\b/.test(sql)
}

/**
 * Where `keyword` first appears at the top level of `sql`: outside parentheses, quotes and comments.
 * A clause inside a subquery or a string literal is not the outer query's.
 */
function topLevelIndex(sql: string, keyword: RegExp): number | undefined {
	const sticky = new RegExp(`(?<![A-Za-z0-9_])(?:${keyword.source})(?![A-Za-z0-9_])`, "iy")
	let depth = 0
	let quote: string | undefined
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i] ?? ""
		if (quote !== undefined) {
			if (ch === "\\") i += 1
			else if (ch === quote) quote = undefined
			continue
		}
		if (ch === "'" || ch === '"' || ch === "`") quote = ch
		else if (ch === "-" && sql[i + 1] === "-") {
			// A line comment runs to the newline; its quotes and parentheses do not count.
			while (i < sql.length && sql[i] !== "\n") i += 1
		} else if (ch === "(") depth += 1
		else if (ch === ")") depth -= 1
		else if (depth === 0) {
			sticky.lastIndex = i
			if (sticky.test(sql)) return i
		}
	}
	return undefined
}

const TRAILING_CLAUSE = /GROUP\s+BY|ORDER\s+BY|LIMIT|FORMAT|SETTINGS/

/**
 * The outer query with `$__orgFilter` ANDed onto its WHERE (or a WHERE added), before its first
 * trailing clause. The existing predicate is grouped, so a top-level OR cannot escape the filter,
 * and a terminal semicolon is dropped so the filter stays inside the statement.
 */
function withOrgFilter(sql: string): string {
	const statement = Str.replace(/;\s*$/, "")(Str.trimEnd(sql))
	const trailingAt = topLevelIndex(statement, TRAILING_CLAUSE)
	const head = trailingAt === undefined ? statement : Str.trimEnd(Str.slice(0, trailingAt)(statement))
	const tail = trailingAt === undefined ? "" : ` ${Str.trimStart(Str.slice(trailingAt)(statement))}`
	const whereAt = topLevelIndex(head, /WHERE/)
	// A `--` comment runs to the end of its line, so text placed after one starts a new line.
	const endsInComment = (text: string) => Str.includes("--")(text)
	if (whereAt === undefined) {
		return `${head}${endsInComment(head) ? "\n" : " "}WHERE $__orgFilter${tail}`
	}
	const predicateAt = whereAt + "WHERE".length
	const predicate = Str.trim(Str.slice(predicateAt)(head))
	const close = endsInComment(predicate) ? "\n)" : ")"
	return `${Str.slice(0, predicateAt)(head)} (${predicate}${close} AND $__orgFilter${tail}`
}

export type NormalizedSql = { readonly sql: string } | { readonly placeholderReason: string }

/** Org-scopes an imported ClickHouse query, or explains why it must stay a placeholder. */
export function normalizeClickHouseSql(sql: string, warnings: string[], panelTitle: string): NormalizedSql {
	if (!hasOrgScope(sql)) {
		warnings.push(
			`Panel "${panelTitle}" was imported as a placeholder because its ClickHouse query does not include $__orgFilter or an OrgId predicate.`,
		)
		return { placeholderReason: "This ClickHouse query needs Maple org scoping before it can run." }
	}

	const fromAt = topLevelIndex(sql, /FROM/)
	// The outer query reads a subquery: its rows may have no OrgId column to filter, so the scope
	// has to be written inside it by hand.
	const readsSubquery = fromAt !== undefined && /^FROM\s*\(/i.test(Str.slice(fromAt)(sql))
	// A UNION, INTERSECT or EXCEPT joins statements that each need their own scope. `SELECT * EXCEPT (col)`
	// is ClickHouse's column exclusion, not a set operation, so EXCEPT counts only before a SELECT.
	const combinesQueries =
		topLevelIndex(sql, /UNION|INTERSECT|EXCEPT\s+(?:ALL\s+|DISTINCT\s+)?\(?\s*SELECT/) !== undefined
	if (!Str.includes("$__orgFilter")(sql) && combinesQueries) {
		warnings.push(
			`Panel "${panelTitle}" was imported as a placeholder because its ClickHouse query combines several SELECTs; add $__orgFilter to each.`,
		)
		return {
			placeholderReason:
				"This ClickHouse query needs $__orgFilter in each of its SELECTs before it can run.",
		}
	}
	if (!Str.includes("$__orgFilter")(sql) && readsSubquery) {
		warnings.push(
			`Panel "${panelTitle}" was imported as a placeholder because its ClickHouse query reads a subquery; add $__orgFilter inside it.`,
		)
		return {
			placeholderReason:
				"This ClickHouse query needs $__orgFilter inside its subquery before it can run.",
		}
	}

	const normalized = Str.includes("$__orgFilter")(sql) ? sql : withOrgFilter(sql)

	if (!Str.includes("$__orgFilter")(sql)) {
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
