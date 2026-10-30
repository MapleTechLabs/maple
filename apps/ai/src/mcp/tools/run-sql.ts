import { McpInvalidInputError, McpQueryBudgetError, McpQueryError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { RunSqlOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { autoBucketSeconds, runRawSql } from "../lib/run-raw-sql"
import { truncate } from "../lib/format"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { MAX_RAW_SQL_RESULT_ROWS, maskLiteralsAndComments } from "@maple/domain/raw-sql"
import { rawSqlErrorText } from "../lib/raw-sql-error-text"
import { withTraceIndexSeek } from "../lib/trace-seek"
import { doc } from "../lib/tool-doc"
import {
	listWarehouseTables,
	suggestWarehouseTables,
} from "@maple/backend/services/warehouse/warehouse-catalog"
import {
	fixUnknownIdentifier,
	type IdentifierRewrite,
	referencedTables,
	unknownIdentifierName,
} from "../lib/sql-identifiers"

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

const NO_FROM_MESSAGE =
	"Raw SQL must read from a Maple table: `$__orgFilter` filters a table's `OrgId`, and this query has no FROM. " +
	"Select constants from a table instead: `SELECT now() FROM traces WHERE $__orgFilter LIMIT 1`."

/** Cap on how many tables one enrichment describes. */
const MAX_DESCRIBED_TABLES = 3

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

		const written = unknownIdentifierName(error.message)
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
		const described = referencedTables(sql).slice(0, MAX_DESCRIBED_TABLES)
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
	`at most ${MAX_RAW_SQL_RESULT_ROWS} are fetched and the first ${MAX_RENDERED_ROWS} rendered, with the count reported. ` +
	"Use it to answer what query_data cannot express, to spot-check data, or to test SQL before saving it " +
	"as a raw_sql widget with add_dashboard_widget. For trends and top-N prefer query_data. " +
	"Spans are in `traces` (there is no otel_spans, otel_traces or spans table) and log lines in `logs`. " +
	"Main tables: traces, logs, metrics_sum/metrics_gauge/metrics_histogram, error_events, session_replays, product_events. " +
	"Time columns: Timestamp on traces, logs, error_events and product_events; TimeUnix on metrics_*; StartTime on session_replays; " +
	"Hour on *_hourly rollups and service_usage; Minute on *_minutely. " +
	"service_usage is a SummingMergeTree (always sum() its counts; TraceCount counts spans); metrics_sum cumulative counters " +
	"carry running totals (never sum Value across points); product_events properties are in Attributes. " +
	"Select 64-bit IDs and hashes as toString(col) to keep their precision. " +
	"traces columns include SpanName (not Name), StatusCode ('Ok'/'Error'/'Unset', no Status), Duration (ns), " +
	"SpanAttributes and ResourceAttributes (no Attributes column on traces). " +
	"Attribute columns are Map(String, String): read them as SpanAttributes['http.route'], never with JSON* functions. " +
	"Compare timestamps to 'YYYY-MM-DD HH:MM:SS' or toDateTime64('...', 9), not ISO strings with T/Z; " +
	"bucket with toStartOfInterval(Timestamp, INTERVAL 5 MINUTE) or toStartOfMinute/Hour (no toStartOfTenSeconds, no intDiv on DateTime64). " +
	"Every non-aggregated SELECT column must be in GROUP BY. " +
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
	"(per span name), service_endpoint_details_hourly (per HTTP route and status), ai_trace_index (agent spans), " +
	"traces_aggregates_hourly, logs_aggregates_hourly, error_events_by_time, trace_list_mv (one row per trace). " +
	"Otherwise narrow start_time/end_time or filter on ServiceName with a Timestamp window."

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

/**
 * SQL the database rejected as written (a typo, `StatusCode = 2` on a String column) is the
 * caller's to fix: an expected 400, not a query failure that opens an error issue.
 */
export const callerSqlAsInvalidInput = (
	cause: { readonly _tag: string },
	error: McpQueryError | McpQueryBudgetError,
): McpQueryError | McpQueryBudgetError | McpInvalidInputError =>
	cause._tag === "@maple/http/errors/WarehouseInvalidSqlError" &&
	error._tag === "@maple/mcp/errors/McpQueryError"
		? new McpInvalidInputError({ message: error.message, parameter: "sql" })
		: error

/** Reruns with a corrected column name before the error goes back to the agent. */
const MAX_IDENTIFIER_FIXES = 3

/** Says which query a failure belongs to when the server already rewrote the agent's SQL. */
const withRewriteNote = (message: string, rewrites: ReadonlyArray<IdentifierRewrite>): string =>
	rewrites.length === 0
		? message
		: `${message}\n\nThis error is for the query rerun with ${rewrites.map((r) => `\`${r.to}\` for \`${r.from}\``).join(", ")}.`

/** The warehouse message in the caller's terms: no gateway database names or row-cap wrapper. */
const withCallerErrorText =
	(rewrites: ReadonlyArray<IdentifierRewrite>) =>
	(error: McpQueryError | McpQueryBudgetError): McpQueryError | McpQueryBudgetError =>
		error._tag === "@maple/mcp/errors/McpQueryError"
			? new McpQueryError({
					message: withRewriteNote(rawSqlErrorText(error.message), rewrites),
					pipeName: error.pipeName,
					cause: error.cause,
				})
			: error

// The cap leaves no overflow row, so only a statement's own LIMIT within the cap proves it whole.
const OWN_LIMIT = /\bLIMIT\s+(\d+)(?:\s*(?:,|OFFSET)\s*\d+)?\s*;?\s*$/i

/** The statement ends in its own LIMIT of at most the cap, so a full page is its answer, not ours. */
const limitedWithinCap = (sql: string): boolean => {
	const own = OWN_LIMIT.exec(maskLiteralsAndComments(sql).trimEnd())
	return own !== null && Number(own[1]) <= MAX_RAW_SQL_RESULT_ROWS
}

type RawSqlRun = ReturnType<typeof runRawSql>

interface FixFailure {
	readonly error: Effect.Error<RawSqlRun>
	/** The statement that failed, after any rewrites. */
	readonly sql: string
	readonly rewrites: ReadonlyArray<IdentifierRewrite>
}

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

			const execute = (sql: string) =>
				runRawSql({
					tenant,
					sql,
					startTime: st,
					endTime: et,
					granularitySeconds,
					truncateAtCap: true,
				})

			// A misspelt column with exactly one right answer is fixed and rerun rather than
			// costing the agent a round trip; each pass fixes the name the warehouse reported.
			const runFixing = (
				sql: string,
				rewrites: ReadonlyArray<IdentifierRewrite>,
			): Effect.Effect<
				Effect.Success<RawSqlRun> & { readonly rewrites: ReadonlyArray<IdentifierRewrite> },
				FixFailure,
				Effect.Services<RawSqlRun>
			> =>
				execute(sql).pipe(
					Effect.map((result) => ({ ...result, rewrites })),
					Effect.catch((error) => {
						const fix =
							error._tag === "@maple/http/errors/RawSqlValidationError" ||
							rewrites.length >= MAX_IDENTIFIER_FIXES
								? undefined
								: fixUnknownIdentifier(sql, error.message)
						return fix === undefined
							? Effect.fail({ error, sql, rewrites })
							: runFixing(fix.sql, [...rewrites, fix.rewrite])
					}),
				)

			// An unbounded trace-id lookup reads through `trace_index`. If the warehouse cannot
			// analyse that form (the predicate sits where `ServiceName` is not in scope), the
			// query runs as written; any other failure is the seek's to report.
			const seeked = withTraceIndexSeek(params.sql)
			const run =
				seeked === undefined
					? runFixing(params.sql, [])
					: runFixing(seeked, []).pipe(
							Effect.catch((failure) =>
								failure.error._tag === "@maple/http/errors/WarehouseInvalidSqlError"
									? runFixing(params.sql, [])
									: Effect.fail(failure),
							),
						)

			const { rows, columns, rowCount, expandedSql, rewrites } = yield* run.pipe(
				Effect.mapError(({ error, sql, rewrites }) =>
					// Macro/safety failures (a missing `$__orgFilter` above all) are caller-fixable.
					error._tag === "@maple/http/errors/RawSqlValidationError"
						? new McpInvalidInputError({
								message: withRewriteNote(
									`SQL rejected (${error.code}): ${error.message}`,
									rewrites,
								),
								parameter: "sql",
								example: RUN_SQL_EXAMPLE,
							})
						: callerSqlAsInvalidInput(
								error,
								// Execution failures surface the warehouse message so the agent can fix the SQL,
								// plus the real table (or column) names when the one it named does not exist:
								// the warehouse message never says what they are.
								withRollupHintOnBudget(
									withColumnListOnUnknownColumn(sql)(
										withTableListOnUnknownTable(
											withCallerErrorText(rewrites)(toMcpQueryError("run_sql")(error)),
											sql,
										),
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
				...(rowCount >= MAX_RAW_SQL_RESULT_ROWS && !limitedWithinCap(params.sql)
					? { atRowCap: true }
					: undefined),
				...(rewrites.length === 0 ? undefined : { rewrites: [...rewrites] }),
				...(params.show_sql === true ? { expandedSql } : undefined),
			}
		}),
		render: (output) => {
			const notices = [
				...(output.atRowCap === true
					? [
							`Stopped at the ${MAX_RAW_SQL_RESULT_ROWS}-row cap, so more rows may exist; aggregate or add a LIMIT to see all of them.`,
						]
					: []),
				...(output.rewrites ?? []).map(
					(r) =>
						`Ran with \`${r.to}\` for \`${r.from}\`, which is not a column here; use \`${r.to}\` directly.`,
				),
				...(hasUnsafeInteger(output.rows)
					? [
							"Some integers exceed 2^53 and lost their last digits in transit; select them as toString(col) for exact values.",
						]
					: []),
			]
			return {
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
										output.columns.map((col) =>
											cellToString(row[col], output.maxCellChars),
										),
									),
								),
							]),
					...(output.expandedSql === undefined ? [] : [doc.code("sql", output.expandedSql)]),
				],
				...(notices.length === 0 ? undefined : { notices }),
				...(output.truncated
					? {
							truncation: {
								shown: output.rows.length,
								total: output.rowCount,
								noun: "rows (refine with LIMIT or filters)",
							},
						}
					: undefined),
			}
		},
	})
}
