import { Effect, Schema } from "effect"
import { type WarehouseError, WarehouseQuotaExceededError, WarehouseSchemaDriftError } from "@maple/domain"
import {
	warehouseHandlers,
	warehouseReadHandlers,
} from "@maple/backend/services/warehouse/warehouse-error-handlers"
import { missingWarehouseTable } from "@maple/backend/services/warehouse/missing-table"
import { describeWarehouseTable } from "@maple/backend/services/warehouse/warehouse-catalog"
import { McpNotReadyError, McpQueryBudgetError, McpQueryError } from "../tools/types"

export { warehouseHandlers, warehouseReadHandlers }

const SCHEMA_DRIFT_HINT =
	" — your ClickHouse cluster's schema is out of sync with what Maple expects. " +
	"Run schema apply from the org's ClickHouse settings page to add the missing columns."

/**
 * Human-facing message for a warehouse error, with the schema-drift remediation
 * hint appended when apt. Without this hint the customer sees only the raw CH
 * error and has to chase infra symptoms (as happened with the SampleRate
 * column). Every MCP surface that renders a warehouse error should go through
 * this, not `error.message`.
 *
 * Row-decoding failures have their own tag and never receive this hint.
 */
export const warehouseErrorText = (error: WarehouseError): string =>
	Schema.is(WarehouseSchemaDriftError)(error) ? `${error.message}${SCHEMA_DRIFT_HINT}` : error.message

const BUDGET_GUIDANCE = {
	max_execution_time:
		"The query ran past its time limit. Narrow start_time/end_time, filter by service or another attribute, " +
		"or aggregate with `query_data` instead of scanning raw rows.",
	max_memory_usage:
		"The query needed more memory than it is allowed. Add filters, or group by fewer and lower-cardinality keys.",
	max_threads: "The query needed more parallelism than it is allowed. Scan less data.",
} satisfies Record<WarehouseQuotaExceededError["setting"], string>

/**
 * Curry the pipe label so call sites read as
 * `Effect.mapError(toMcpQueryError("service_overview"))`.
 *
 * A budget breach gets its own error with guidance: the raw text is the vendor's ("Upgrade your
 * plan for higher capacity"), which no model can act on.
 */
export const toMcpQueryError =
	(pipe: string) =>
	(error: WarehouseError): McpQueryError | McpQueryBudgetError =>
		Schema.is(WarehouseQuotaExceededError)(error)
			? new McpQueryBudgetError({
					message: BUDGET_GUIDANCE[error.setting],
					pipeName: pipe,
					setting: error.setting,
				})
			: new McpQueryError({ message: warehouseErrorText(error), pipeName: pipe, cause: error })

/**
 * The same, for SQL Maple wrote: one of Maple's own tables not deployed for the org yet (a deploy
 * still rolling out, an unapplied BYO schema) is not the call's fault and not a bug, so it reads
 * as not ready. Caller SQL keeps {@link toMcpQueryError}: a table it names may just be a typo.
 */
export const toMcpReadError =
	(pipe: string) =>
	(error: WarehouseError): McpQueryError | McpQueryBudgetError | McpNotReadyError => {
		const table = missingWarehouseTable(error)
		return table === undefined || describeWarehouseTable(table) === null
			? toMcpQueryError(pipe)(error)
			: new McpNotReadyError({
					message: missingTableText(table),
					retryAfterSeconds: MISSING_TABLE_RETRY_SECONDS,
				})
	}

/** A missing table stays visible in logs: if it never clears, a misrouted token may be the cause. */
const failRead = (
	pipe: string,
	error: WarehouseError,
): Effect.Effect<never, McpQueryError | McpQueryBudgetError | McpNotReadyError> => {
	const mapped = toMcpReadError(pipe)(error)
	return mapped._tag === "@maple/mcp/errors/McpNotReadyError"
		? Effect.logWarning("Maple warehouse table missing for org").pipe(
				Effect.annotateLogs({ "maple.mcp.pipe": pipe, "error.message": error.message }),
				Effect.andThen(Effect.fail(mapped)),
			)
		: Effect.fail(mapped)
}

/** Long enough for a deploy to finish creating the table. */
const MISSING_TABLE_RETRY_SECONDS = 120

const missingTableText = (table: string): string =>
	`The \`${table}\` table this tool reads is not deployed for this org yet (usually a deploy still rolling out). ` +
	"If the org runs its own ClickHouse, an admin applies the schema from the ClickHouse settings page."

/**
 * `Effect.catchTags` handler map that converts every warehouse error tag into an
 * MCP error ({@link toMcpReadError}: the schema-drift hint, a missing table as not ready), leaving any non-warehouse errors
 * (e.g. the MCP auth errors from `CurrentMcpTenant`) untouched. Apply inline so the
 * residual error channel infers from the caught tags:
 * `effect.pipe(Effect.catchTags(warehouseToMcpHandlers("pipe_label")))`.
 */
export const warehouseToMcpHandlers = (pipe: string) => warehouseHandlers((error) => failRead(pipe, error))

/**
 * The same, for reads that compile their own SQL (the AI agent-session and
 * tool-analytics tools). Their error channel carries no raw-SQL token tags, and
 * `catchTags` refuses a handler table wider than the channel — so the full
 * {@link warehouseToMcpHandlers} does not typecheck against them.
 */
export const warehouseReadToMcpHandlers = (pipe: string) =>
	warehouseReadHandlers((error) => failRead(pipe, error))
