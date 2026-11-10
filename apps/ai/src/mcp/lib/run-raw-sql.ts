import { Effect } from "effect"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	type AuditedRawSqlInput,
	makeRunAuditedRawSql,
} from "@maple/backend/services/warehouse/audited-raw-sql"

/**
 * Raw SQL with the signed-in route's guardrails, bucket policy and audit entry. Shared by the
 * `run_sql` MCP tool and `inspect_chart_data`'s raw_sql_chart branch.
 */
export const runRawSql = Effect.fn("McpRawSql.runRawSql")(function* (
	input: Omit<AuditedRawSqlInput, "context">,
) {
	const warehouse = yield* WarehouseQueryService
	return yield* makeRunAuditedRawSql(warehouse)({ ...input, context: "mcp.run_sql" })
})
