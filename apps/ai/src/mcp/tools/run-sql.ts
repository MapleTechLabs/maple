import { McpInvalidInputError, McpQueryBudgetError, McpQueryError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { RunSqlOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { autoBucketSeconds, runRawSql } from "../lib/run-raw-sql"
import { truncate } from "../lib/format"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { MAX_RAW_SQL_RESULT_ROWS } from "@maple/domain/raw-sql"
import { doc } from "../lib/tool-doc"
import {
	describeWarehouseTable,
	listWarehouseTables,
	suggestWarehouseTables,
} from "@maple/backend/services/warehouse/warehouse-catalog"

// Rows returned to the model are capped so a wide/long result doesn't blow the
// context. The full count is always reported via meta.rowCount.
const MAX_RENDERED_ROWS = 100

/**
 * Matches how each backend words a missing relation: ClickHouse says "Unknown
 * table"/"doesn't exist", the Tinybird gateway says "Resource '<name>' not found".
 */
const UNKNOWN_TABLE = /unknown table|table .* does(?:n't| not) exist|Resource '[^']*' not found/i

const MISSING_TABLE_NAME_RES = [
	/Resource '([^']+)' not found/i,
	/Unknown table expression identifier [`']([^`']+)[`']/i,
	/Unknown table [`']?([\w.]+)/i,
	/Table [`']?([\w.]+?)[`']? does(?:n't| not) exist/i,
]

/** Names the error or the query's FROM/JOIN clauses use that are neither catalog tables nor CTEs. */
const unknownTableNames = (message: string, sql: string): ReadonlyArray<string> => {
	const known = new Set(listWarehouseTables().map((t) => t.name))
	const ctes = new Set([...sql.matchAll(/\b([A-Za-z_]\w*)\s+AS\s*\(/gi)].map((m) => m[1]))
	const named = [
		...MISSING_TABLE_NAME_RES.flatMap((re) => {
			const name = message.match(re)?.[1]
			return name === undefined ? [] : [name]
		}),
		...[...sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][\w.]*)/gi)].map((m) => m[1]),
	]
	return [...new Set(named)].filter((name) => !known.has(name.split(".").at(-1) ?? name) && !ctes.has(name))
}

export const withTableListOnUnknownTable = (
	error: McpQueryError | McpQueryBudgetError,
	sql = "",
): McpQueryError | McpQueryBudgetError => {
	if (error._tag !== "@maple/mcp/errors/McpQueryError" || !UNKNOWN_TABLE.test(error.message)) return error
	const names = listWarehouseTables()
		.map((t) => t.name)
		.join(", ")
	const guesses = unknownTableNames(error.message, sql).flatMap((name) => {
		const suggested = suggestWarehouseTables(name)
		return suggested.length === 0
			? []
			: [
					`\`${name}\` is not a Maple table; did you mean ${suggested.map((t) => `\`${t}\``).join(" or ")}?`,
				]
	})
	return new McpQueryError({
		message: `${error.message}\n\n${guesses.map((g) => `${g}\n`).join("")}Available tables: ${names}.\nCall describe_warehouse_tables with a table name for its columns.`,
		pipeName: error.pipeName,
		cause: error.cause,
	})
}

/**
 * Matches how each backend words a column that isn't on the referenced table.
 * ClickHouse's analyzer says "Unknown expression or function identifier '<x>' in
 * scope <query>"; the older paths say "Unknown identifier" / "Missing columns" /
 * "There's no column".
 */
const UNKNOWN_COLUMN =
	/unknown (?:expression (?:or function )?)?identifier|missing columns|there(?:'s| is) no column|no such column/i

/** The column an unknown-column error names, as written. */
const missingColumnName = (message: string): string | undefined => {
	const match = message.match(
		/identifier [`']([^`']+)[`']|Missing columns: '([^']+)'|no column [`']([^`']+)[`']/i,
	)
	return match?.[1] ?? match?.[2] ?? match?.[3]
}

const NO_FROM_MESSAGE =
	"Raw SQL must read from a Maple table: `$__orgFilter` filters a table's `OrgId`, and this query has no FROM. " +
	"Select constants from a table instead: `SELECT now() FROM traces WHERE $__orgFilter LIMIT 1`."

/** Cap on how many tables one enrichment describes. */
const MAX_DESCRIBED_TABLES = 3

/** Catalog tables the submitted SQL actually names, in first-mention order. */
const referencedTables = (sql: string): ReadonlyArray<string> =>
	listWarehouseTables()
		.map((t) => ({ name: t.name, at: sql.search(new RegExp(`\\b${t.name}\\b`)) }))
		.filter((t) => t.at >= 0)
		.sort((a, b) => a.at - b.at)
		.map((t) => t.name)

/**
 * The column counterpart of `withTableListOnUnknownTable`, and it exists for the
 * same reason: the warehouse names the column the agent invented but never the
 * ones that exist, so a wrong guess on a rollup table (`Count`/`Timestamp`/
 * `ServiceName` against `attribute_keys_hourly`, whose columns are `Hour` and
 * `UsageCount` and which has no per-service dimension at all) fails every retry.
 * Put the real columns in the error rather than pointing at a tool agents skip.
 */
export const withColumnListOnUnknownColumn =
	(sql: string) =>
	(error: McpQueryError | McpQueryBudgetError): McpQueryError | McpQueryBudgetError => {
		if (error._tag !== "@maple/mcp/errors/McpQueryError" || !UNKNOWN_COLUMN.test(error.message))
			return error

		const written = missingColumnName(error.message)
		const column = written?.split(".").at(-1)
		// A table-less SELECT fails on the org filter itself; say that, not "unknown OrgId".
		if (column === "OrgId" && !/\bFROM\b/i.test(sql)) {
			return new McpQueryError({
				message: NO_FROM_MESSAGE,
				pipeName: error.pipeName,
				cause: error.cause,
			})
		}

		// Only the tables the query names; a schema dump of all 38 would bury the
		// message it is attached to.
		const described = referencedTables(sql)
			.slice(0, MAX_DESCRIBED_TABLES)
			.map((name) => describeWarehouseTable(name))
			.filter((info) => info !== null)
		if (described.length === 0) return error

		// A column Maple's schema has but the warehouse lacks only happens on a cluster
		// whose schema is behind (BYO ClickHouse); a plain typo gets the real columns.
		const expectedOn = described.find((info) => info.columns.some((c) => c.name === column))
		if (written !== undefined && column !== undefined && column !== written && expectedOn !== undefined) {
			const alias = written.slice(0, written.length - column.length - 1)
			return new McpQueryError({
				message:
					`${error.message}\n\n\`${column}\` exists on \`${expectedOn.name}\`, so \`${alias}\` is not an alias in scope here. ` +
					`Define it (\`FROM ${expectedOn.name} AS ${alias}\`) or drop the qualifier; for joins use \`$__orgFilter(${alias})\`.`,
				pipeName: error.pipeName,
				cause: error.cause,
			})
		}
		if (column !== undefined && expectedOn !== undefined) {
			return new McpQueryError({
				message:
					`${error.message}\n\n\`${column}\` is part of Maple's schema for \`${expectedOn.name}\`. ` +
					"If it is spelled and qualified correctly and this org uses its own ClickHouse cluster, that cluster's " +
					"schema is behind: run schema apply from the org's ClickHouse settings.",
				pipeName: error.pipeName,
				cause: error.cause,
			})
		}

		const listing = described.map(
			(info) => `\`${info.name}\`: ${info.columns.map((c) => c.name).join(", ")}`,
		)
		return new McpQueryError({
			message: `${error.message}\n\nColumns available:\n${listing.join("\n")}`,
			pipeName: error.pipeName,
			cause: error.cause,
		})
	}

const WINDOW = P.timeWindow({ defaultHours: 6 })

const RUN_SQL_EXAMPLE = "SELECT count() AS c FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)"

const DEFAULT_CELL_CHARS = 120
const MAX_CELL_CHARS = 2_000

const runSqlSchema = Schema.Struct({
	sql: P.text(
		"The SELECT. It MUST contain `$__orgFilter` (expands to `(OrgId = '<your-org>')`) as a top-level AND condition; " +
			"a query without it, or with it OR-ed against another condition, is rejected. In joins use `$__orgFilter(alias)` " +
			"(`(alias.OrgId = '<your-org>')`) once per joined table. " +
			"Other macros: `$__timeFilter(Column)` (`Column >= <start> AND Column <= <end>`), `$__startTime`, `$__endTime`, " +
			"`$__interval_s` (bucket width for toStartOfInterval). Only one statement; DDL/DML, SETTINGS and system tables are rejected.",
	),
	...WINDOW.fields,
	granularity_seconds: P.optionalNumber(
		"Value of `$__interval_s`. Auto-computed from the window when omitted.",
	),
	max_cell_chars: P.optionalNumber(
		`Clip each rendered cell to this many characters (default ${DEFAULT_CELL_CHARS}, max ${MAX_CELL_CHARS}). Raise it to read long values such as log bodies or stack traces.`,
	),
	show_sql: P.optionalFlag("Also return the macro-expanded SQL that ran (default false)."),
})

const runSqlDescription =
	"Run one read-only ClickHouse SELECT against the org's warehouse and return its rows: " +
	`at most ${MAX_RAW_SQL_RESULT_ROWS} are fetched and the first ${MAX_RENDERED_ROWS} rendered, with the true count reported. ` +
	"Use it to answer what query_data cannot express, to spot-check data, or to test SQL before saving it " +
	"as a raw_sql widget with add_dashboard_widget. For trends and top-N prefer query_data. " +
	"Spans are in `traces` (there is no otel_spans, otel_traces or spans table) and log lines in `logs`. " +
	"Main tables: traces, logs, metrics_sum/metrics_gauge/metrics_histogram, error_events, session_replays, product_events. " +
	"Time columns: Timestamp on traces, logs, error_events and product_events; TimeUnix on metrics_*; StartTime on session_replays; " +
	"Hour on *_hourly rollups and service_usage; Minute on *_minutely. " +
	"service_usage is a SummingMergeTree (always sum() its counts; TraceCount counts spans); metrics_sum cumulative counters " +
	"carry running totals (never sum Value across points); product_events properties are in Attributes. " +
	"Select 64-bit IDs and hashes as toString(col) to keep their precision. " +
	"describe_warehouse_tables gives every table's columns and notes."

/** Twelve significant digits: hides binary float noise (8282.599999999999) without losing real precision. */
const roundFloat = (value: number): number =>
	Number.isInteger(value) ? value : Number(value.toPrecision(12))

/** A warehouse cell as JSON: 64-bit ints can arrive as bigint, and nothing else is JSON-unsafe. */
export const toJson = (value: unknown): Schema.Json => {
	if (value === null || value === undefined) return null
	if (typeof value === "string" || typeof value === "boolean") return value
	if (typeof value === "number") return Number.isFinite(value) ? roundFloat(value) : String(value)
	if (typeof value === "bigint") return value.toString()
	if (Array.isArray(value)) return value.map(toJson)
	if (typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]))
	return String(value)
}

/** Whether a time macro put the window into the statement; otherwise the SQL picks its own range. */
const usesWindow = (expandedSql: string, start: string, end: string) =>
	expandedSql.includes(`toDateTime('${start}')`) || expandedSql.includes(`toDateTime('${end}')`)

/** Raw cell text with control characters made visible, so a row stays one table line. */
export function cellToString(value: Schema.Json | undefined, maxChars = DEFAULT_CELL_CHARS): string {
	const text =
		value === null || value === undefined
			? "null"
			: typeof value === "object"
				? JSON.stringify(value)
				: String(value)
	return truncate(text.replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t"), maxChars)
}

/** An integer past 2^53 has already lost digits in the warehouse's JSON; say so rather than show it as exact. */
const hasUnsafeInteger = (rows: ReadonlyArray<Record<string, Schema.Json>>): boolean =>
	rows.some((row) =>
		Object.values(row).some(
			(v) => typeof v === "number" && !Number.isSafeInteger(v) && Number.isInteger(v),
		),
	)

const BUDGET_ROLLUP_HINT =
	"Pre-aggregated tables answer most per-service questions without scanning raw spans: service_overview_minutely / " +
	"service_overview_hourly (requests, errors, latency per service), service_operations_minutely / service_operations_hourly " +
	"(per span name), traces_aggregates_hourly, logs_aggregates_hourly, error_events_by_time, trace_list_mv (one row per trace). " +
	"Otherwise narrow start_time/end_time or filter on the sorting key (ServiceName first on traces and logs)."

/** Point a query that ran out of time or memory at the rollups that answer it cheaply. */
export const withRollupHintOnBudget = (
	error: McpQueryError | McpQueryBudgetError,
): McpQueryError | McpQueryBudgetError =>
	error._tag === "@maple/mcp/errors/McpQueryBudgetError" && error.setting !== "max_threads"
		? new McpQueryBudgetError({
				message: `${error.message} ${BUDGET_ROLLUP_HINT}`,
				pipeName: error.pipeName,
				setting: error.setting,
			})
		: error

export function registerRunSqlTool(server: McpToolRegistrar) {
	server.define({
		name: "run_sql",
		title: "Run SQL",
		description: runSqlDescription,
		parameters: runSqlSchema,
		output: RunSqlOutput,
		hints: { readOnly: true },
		phrases: ["Running a query", "Running SQL", "Querying the warehouse"],
		handler: Effect.fn("McpTool.runSql")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const { st, et } = yield* WINDOW.resolve(params, "run_sql")
			const granularitySeconds = params.granularity_seconds ?? autoBucketSeconds(st, et)

			const { rows, columns, rowCount, expandedSql } = yield* runRawSql({
				tenant,
				sql: params.sql,
				startTime: st,
				endTime: et,
				granularitySeconds,
			}).pipe(
				Effect.mapError((error) =>
					// Macro/safety failures (a missing `$__orgFilter` above all) are caller-fixable.
					error._tag === "@maple/http/errors/RawSqlValidationError"
						? new McpInvalidInputError({
								message: `SQL rejected (${error.code}): ${error.message}`,
								parameter: "sql",
								example: RUN_SQL_EXAMPLE,
							})
						: // Execution failures surface the warehouse message so the agent can fix the SQL,
							// plus the real table (or column) names when the one it named does not exist:
							// the warehouse message never says what they are.
							withRollupHintOnBudget(
								withColumnListOnUnknownColumn(params.sql)(
									withTableListOnUnknownTable(
										toMcpQueryError("run_sql")(error),
										params.sql,
									),
								),
							),
				),
			)

			const rendered = rows.slice(0, MAX_RENDERED_ROWS)
			const maxCellChars = Math.min(
				MAX_CELL_CHARS,
				Math.max(10, Math.round(params.max_cell_chars ?? DEFAULT_CELL_CHARS)),
			)
			return {
				rowCount,
				columns: [...columns],
				rows: rendered.map((row) =>
					Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toJson(v)])),
				),
				truncated: rowCount > rendered.length,
				timeRange: { start: st, end: et },
				maxCellChars,
				windowApplied: usesWindow(expandedSql, st, et),
				...(params.show_sql === true ? { expandedSql } : undefined),
			}
		}),
		render: (output) => ({
			title: "SQL result",
			scope: [
				[
					"Time range",
					output.windowApplied !== false
						? `${output.timeRange.start} to ${output.timeRange.end}`
						: "set by the SQL (no $__timeFilter/$__startTime/$__endTime macro)",
				],
				["Rows", String(output.rowCount)],
				["Columns", String(output.columns.length)],
			],
			...(output.rowCount === 0 ? { empty: { message: "No rows returned." } } : undefined),
			blocks: [
				...(output.rowCount === 0
					? []
					: [
							doc.table(
								[...output.columns],
								output.rows.map((row) =>
									output.columns.map((col) => cellToString(row[col], output.maxCellChars)),
								),
							),
						]),
				...(output.expandedSql === undefined ? [] : [doc.code("sql", output.expandedSql)]),
			],
			...(hasUnsafeInteger(output.rows)
				? {
						notices: [
							"Some integers exceed 2^53 and lost their last digits in transit; select them as toString(col) for exact values.",
						],
					}
				: undefined),
			...(output.truncated
				? {
						truncation: {
							shown: output.rows.length,
							total: output.rowCount,
							noun: "rows (refine with LIMIT or filters)",
						},
					}
				: undefined),
		}),
	})
}
