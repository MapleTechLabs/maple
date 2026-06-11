import { Context, type Effect, type Option } from "effect"
import type { WarehouseError } from "@maple/domain/http/warehouse-errors"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import type { CompiledQuery } from "../ch"

/**
 * The error channel of every `WarehouseExecutor` method. This is the warehouse
 * error union from `@maple/domain/http/warehouse-errors` (the PURE module — no
 * HttpApi dependency), so this subpath and its CLI consumers stay free of the
 * HttpApi AST builder.
 */
export type WarehouseExecutorError = WarehouseError

/**
 * ClickHouse settings a call site may request. Row/byte caps
 * (`max_rows_to_read`, `max_result_rows`, `max_bytes_to_read`) are restricted
 * by Tinybird and intentionally absent. `maxBlockSize` is ClickHouse-only —
 * the executor strips it when the resolved backend is Tinybird (see
 * `WarehouseQuerySettings.maxBlockSize` in `../profiles` for the rationale).
 */
export type ExecutorQuerySettings = {
	maxExecutionTime?: number
	maxMemoryUsage?: number
	maxThreads?: number
	maxBlockSize?: number
}

export type ExecutorQueryProfile = "discovery" | "list" | "aggregation" | "explain" | "unbounded"

export type ExecutorQueryOptions = {
	profile?: ExecutorQueryProfile
	settings?: ExecutorQuerySettings
}

export interface WarehouseExecutorShape {
	/** The org ID for the current tenant — needed for raw SQL queries. */
	readonly orgId: string

	readonly query: <T = any>(
		pipe: WarehouseQueryName,
		params: Record<string, unknown>,
		options?: ExecutorQueryOptions,
	) => Effect.Effect<{ data: ReadonlyArray<T> }, WarehouseExecutorError>

	/** Execute raw ClickHouse SQL. The SQL MUST include an OrgId filter. */
	readonly sqlQuery: <T = Record<string, unknown>>(
		sql: string,
		options?: ExecutorQueryOptions,
	) => Effect.Effect<ReadonlyArray<T>, WarehouseExecutorError>

	readonly compiledQuery: <T>(
		compiled: CompiledQuery<T>,
		options?: ExecutorQueryOptions,
	) => Effect.Effect<ReadonlyArray<T>, WarehouseExecutorError>

	readonly compiledQueryFirst: <T>(
		compiled: CompiledQuery<T>,
		options?: ExecutorQueryOptions,
	) => Effect.Effect<Option.Option<T>, WarehouseExecutorError>
}

export class WarehouseExecutor extends Context.Service<WarehouseExecutor, WarehouseExecutorShape>()(
	"@maple/query-engine/observability/WarehouseExecutor",
) {}
