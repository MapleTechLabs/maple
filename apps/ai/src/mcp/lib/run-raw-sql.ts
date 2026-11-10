import { Effect } from "effect"
import type { RawSqlValidationError, TenantContext } from "@maple/domain/http"
import type { WarehouseExecutionError } from "@maple/query-engine/execution"
import { computeBucketSecondsForRange } from "@maple/query-engine"
import { makeExecuteRawSql } from "@maple/query-engine/runtime"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { describeFailure, recordRawSqlAudit } from "@maple/backend/services/audit/audit-access"

/**
 * `$__interval_s` when the caller doesn't pin `granularitySeconds`.
 *
 * `BUCKET_POLICIES.rawSql`, the same policy the signed-in raw-SQL route
 * (`executeRawSql` in `routes/internal/query-engine.http.ts`) applies, so
 * `inspect_chart_data` buckets a raw-SQL tile exactly as the board does.
 */
export function autoBucketSeconds(startTime: string, endTime: string): number {
	return computeBucketSecondsForRange(startTime, endTime, "rawSql")
}

export interface RunRawSqlInput {
	readonly tenant: TenantContext
	readonly sql: string
	readonly startTime: string
	readonly endTime: string
	readonly granularitySeconds: number
	/** Stop at the 1,000-row cap instead of failing on a longer result. */
	readonly truncateAtCap?: boolean
}

/**
 * Expand the raw-SQL macros (`$__orgFilter`, `$__timeFilter(col)`, …) with the
 * full safety pass (required org filter, DDL/DML deny-list, single-statement,
 * auto-LIMIT) and run the result through `WarehouseQueryService.rawSqlQuery`,
 * returning the rows plus column/row metadata. Shared by the `run_sql` MCP tool
 * and `inspect_chart_data`'s raw_sql_chart branch so both honor the identical
 * guardrails. Fails with `RawSqlValidationError` (macro/safety) or a
 * `WarehouseError` (execution); callers surface these to the agent.
 */
export const runRawSql = Effect.fn("McpRawSql.runRawSql")(function* (input: RunRawSqlInput) {
	const warehouse = yield* WarehouseQueryService
	const executeRawSql = makeExecuteRawSql<TenantContext, WarehouseExecutionError | RawSqlValidationError>(
		warehouse,
	)
	const audit = (result: Parameters<typeof recordRawSqlAudit>[0]["result"]) =>
		recordRawSqlAudit({
			tenant: input.tenant,
			sql: input.sql,
			context: "mcp.run_sql",
			startTime: input.startTime,
			endTime: input.endTime,
			result,
		})
	return yield* executeRawSql(input.tenant, {
		sql: input.sql,
		orgId: input.tenant.orgId,
		startTime: input.startTime,
		endTime: input.endTime,
		granularitySeconds: input.granularitySeconds,
		...(input.truncateAtCap === true ? { truncateAtCap: true } : undefined),
		workload: "interactive",
		context: "mcp.run_sql",
	}).pipe(
		// Every statement is audited, however it ended: a refused one as `denied`.
		Effect.tap((result) => audit({ _tag: "rows", rowCount: result.rowCount })),
		Effect.tapError((error) =>
			audit(
				error._tag === "@maple/http/errors/RawSqlValidationError"
					? { _tag: "rejected", reason: error.message }
					: { _tag: "failed", error: describeFailure(error) },
			),
		),
	)
})
