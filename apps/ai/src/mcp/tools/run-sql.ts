import { McpInvalidInputError, McpQueryError, type McpQueryBudgetError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { RunSqlOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { autoBucketSeconds, runRawSql } from "../lib/run-raw-sql"
import { truncate } from "../lib/format"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import {
	describeWarehouseTable,
	listWarehouseTables,
} from "@maple/backend/services/warehouse/warehouse-catalog"

// Rows returned to the model are capped so a wide/long result doesn't blow the
// context. The full count is always reported via meta.rowCount.
const MAX_RENDERED_ROWS = 100

/**
 * Matches how each backend words a missing relation: ClickHouse says "Unknown
 * table"/"doesn't exist", the Tinybird gateway says "Resource '<name>' not found".
 */
const UNKNOWN_TABLE = /unknown table|table .* does(?:n't| not) exist|Resource '[^']*' not found/i

export const withTableListOnUnknownTable = (
	error: McpQueryError | McpQueryBudgetError,
): McpQueryError | McpQueryBudgetError => {
	if (error._tag !== "@maple/mcp/errors/McpQueryError" || !UNKNOWN_TABLE.test(error.message)) return error
	const names = listWarehouseTables()
		.map((t) => t.name)
		.join(", ")
	return new McpQueryError({
		message: `${error.message}\n\nAvailable tables: ${names}.\nCall describe_warehouse_tables with a table name for its columns.`,
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
const UNKNOWN_COLUMN = /unknown (?:expression or function )?identifier|missing columns|there'?s no column/i

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

		// Only the tables the query names; a schema dump of all 38 would bury the
		// message it is attached to.
		const described = referencedTables(sql)
			.slice(0, MAX_DESCRIBED_TABLES)
			.map((name) => describeWarehouseTable(name))
			.filter((info) => info !== null)
		if (described.length === 0) return error

		const listing = described.map(
			(info) => `\`${info.name}\`: ${info.columns.map((c) => c.name).join(", ")}`,
		)
		return new McpQueryError({
			message: `${error.message}\n\nColumns available —\n${listing.join("\n")}`,
			pipeName: error.pipeName,
			cause: error.cause,
		})
	}

const WINDOW = P.timeWindow({ defaultHours: 6 })

const RUN_SQL_EXAMPLE = "SELECT count() AS c FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)"

const runSqlSchema = Schema.Struct({
	sql: P.text(
		"Raw ClickHouse SQL to run read-only. MUST reference the `$__orgFilter` macro " +
			"(expands to `OrgId = '<your-org>'`) so the query is scoped to your org; queries without it are rejected. " +
			"Optional macros: `$__timeFilter(Column)` (expands to `Column >= <start> AND Column <= <end>`), " +
			"`$__startTime`, `$__endTime`, `$__interval_s` (bucket width in seconds for toStartOfInterval). " +
			"Only a single SELECT is allowed; DDL/DML keywords (INSERT, DROP, ALTER, ...) are rejected. " +
			"An outer 1,000-row result cap is always enforced. " +
			"Use describe_warehouse_tables to discover table/column names.",
	),
	...WINDOW.fields,
	granularity_seconds: P.optionalNumber(
		"Value substituted for the `$__interval_s` macro. Auto-computed from the time range if omitted.",
	),
})

const runSqlDescription =
	"Run read-only ClickHouse SQL against your org's warehouse and return the rows. " +
	"Use this to verify a raw query before saving it as a raw_sql_chart widget, to spot-check data, " +
	"or to answer questions the structured tools (query_data, explore_attributes) can't express. " +
	"Org isolation is automatic and required via the `$__orgFilter` macro. Read-only: writes/DDL are rejected and an auto-LIMIT is applied. " +
	"For dashboard widgets prefer add_dashboard_widget; for trends/top-N prefer query_data."

/** A warehouse cell as JSON: 64-bit ints can arrive as bigint, and nothing else is JSON-unsafe. */
const toJson = (value: unknown): Schema.Json => {
	if (value === null || value === undefined) return null
	if (typeof value === "string" || typeof value === "boolean") return value
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
	if (typeof value === "bigint") return value.toString()
	if (Array.isArray(value)) return value.map(toJson)
	if (typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]))
	return String(value)
}

function cellToString(value: Schema.Json | undefined): string {
	if (value === null || value === undefined) return "null"
	if (typeof value === "object") return truncate(JSON.stringify(value), 60)
	return truncate(String(value), 60)
}

export function registerRunSqlTool(server: McpToolRegistrar) {
	server.define({
		name: "run_sql",
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
							withColumnListOnUnknownColumn(params.sql)(
								withTableListOnUnknownTable(toMcpQueryError("run_sql")(error)),
							),
				),
			)

			const rendered = rows.slice(0, MAX_RENDERED_ROWS)
			return {
				expandedSql,
				rowCount,
				columns: [...columns],
				rows: rendered.map((row) =>
					Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toJson(v)])),
				),
				truncated: rowCount > rendered.length,
				timeRange: { start: st, end: et },
			}
		}),
		render: (output) => ({
			title: "SQL result",
			scope: [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
				["Rows", String(output.rowCount)],
				["Columns", String(output.columns.length)],
			],
			...(output.rowCount === 0 ? { empty: { message: "No rows returned." } } : undefined),
			blocks:
				output.rowCount === 0
					? []
					: [
							doc.table(
								[...output.columns],
								output.rows.map((row) => output.columns.map((col) => cellToString(row[col]))),
							),
						],
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
