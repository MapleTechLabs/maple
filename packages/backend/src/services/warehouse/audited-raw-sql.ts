import { Effect } from "effect"
import type { RawSqlValidationError, TenantContext } from "@maple/domain/http"
import type { WarehouseExecutionError } from "@maple/query-engine/execution"
import { computeBucketSecondsForRange } from "@maple/query-engine"
import { makeExecuteRawSql } from "@maple/query-engine/runtime"
import { describeFailure, recordRawSqlAudit } from "../audit/audit-access"
import type { WarehouseQueryServiceApi } from "./WarehouseQueryService"

export interface AuditedRawSqlInput {
	readonly tenant: TenantContext
	readonly sql: string
	readonly startTime: string
	readonly endTime: string
	/** `$__interval_s`; unset uses `BUCKET_POLICIES.rawSql`, whose 300s floor keeps scans coarse. */
	readonly granularitySeconds?: number | undefined
	/** Stop at the 1,000-row cap instead of failing on a longer result. */
	readonly truncateAtCap?: boolean
	/** Executor context label, also the audit entry's `context` (`rawSql`, `mcp.run_sql`). */
	readonly context: string
}

/**
 * Raw SQL through the full safety pass (macros, required org filter, deny-list, auto-LIMIT) and
 * the warehouse. Every statement is audited however it ended; a refused one as `denied`.
 */
export const makeRunAuditedRawSql = (warehouse: WarehouseQueryServiceApi) => {
	const executeRawSql = makeExecuteRawSql<TenantContext, WarehouseExecutionError | RawSqlValidationError>(
		warehouse,
	)
	return Effect.fnUntraced(function* (input: AuditedRawSqlInput) {
		const audit = (result: Parameters<typeof recordRawSqlAudit>[0]["result"]) =>
			recordRawSqlAudit({
				tenant: input.tenant,
				sql: input.sql,
				context: input.context,
				startTime: input.startTime,
				endTime: input.endTime,
				result,
			})
		return yield* executeRawSql(input.tenant, {
			sql: input.sql,
			orgId: input.tenant.orgId,
			startTime: input.startTime,
			endTime: input.endTime,
			granularitySeconds:
				input.granularitySeconds ??
				computeBucketSecondsForRange(input.startTime, input.endTime, "rawSql"),
			...(input.truncateAtCap === true ? { truncateAtCap: true } : undefined),
			workload: "interactive",
			context: input.context,
		}).pipe(
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
}
