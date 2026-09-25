import { Effect } from "effect"
import { type WarehouseError, WarehouseQuotaExceededError, WarehouseSchemaDriftError } from "@maple/domain"
import {
	warehouseHandlers,
	warehouseReadHandlers,
} from "@maple/backend/services/warehouse/warehouse-error-handlers"
import { McpQueryBudgetError, McpQueryError } from "../tools/types"

export { warehouseHandlers, warehouseReadHandlers }

const SCHEMA_DRIFT_HINT =
	" — your ClickHouse cluster's schema is out of sync with what Maple expects. " +
	"Run schema apply from the org's ClickHouse settings page (or POST " +
	"/api/org-clickhouse-settings/apply-schema) to add the missing columns."

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
	error instanceof WarehouseSchemaDriftError ? `${error.message}${SCHEMA_DRIFT_HINT}` : error.message

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
		error instanceof WarehouseQuotaExceededError
			? new McpQueryBudgetError({
					message: BUDGET_GUIDANCE[error.setting],
					pipeName: pipe,
					setting: error.setting,
				})
			: new McpQueryError({ message: warehouseErrorText(error), pipeName: pipe, cause: error })

/**
 * `Effect.catchTags` handler map that converts every warehouse error tag into an
 * `McpQueryError` (with the schema-drift hint), leaving any non-warehouse errors
 * (e.g. the MCP auth errors from `CurrentMcpTenant`) untouched. Apply inline so the
 * residual error channel infers from the caught tags:
 * `effect.pipe(Effect.catchTags(warehouseToMcpHandlers("pipe_label")))`.
 */
export const warehouseToMcpHandlers = (pipe: string) =>
	warehouseHandlers((error) => Effect.fail(toMcpQueryError(pipe)(error)))

/**
 * The same, for reads that compile their own SQL (the AI agent-session and
 * tool-analytics tools). Their error channel carries no raw-SQL token tags, and
 * `catchTags` refuses a handler table wider than the channel — so the full
 * {@link warehouseToMcpHandlers} does not typecheck against them.
 */
export const warehouseReadToMcpHandlers = (pipe: string) =>
	warehouseReadHandlers((error) => Effect.fail(toMcpQueryError(pipe)(error)))
