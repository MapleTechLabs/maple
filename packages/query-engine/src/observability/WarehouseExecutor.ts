import { Effect, Schema, Context } from "effect"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import type { QueryProfileName, WarehouseQueryOptions, WarehouseQuerySettings } from "../profiles"

export class ObservabilityError extends Schema.TaggedErrorClass<ObservabilityError>()(
	"@maple/query-engine/errors/ObservabilityError",
	{
		message: Schema.String,
		pipe: Schema.optionalKey(Schema.String),
		cause: Schema.optionalKey(Schema.Defect),
		// Mirrors `WarehouseQueryError.category` from @maple/domain — kept loose
		// here (Schema.String) so this package doesn't take a dependency on the
		// HTTP-domain error union. Today: "query" | "upstream" | "auth" |
		// "config" | "client" | "schema_drift". MCP and HTTP layers branch on
		// "schema_drift" to surface a remediation hint.
		category: Schema.optionalKey(Schema.String),
	},
) {}

/**
 * Profile / settings selectors are defined canonically in `../profiles` (the
 * single source of truth shared by `WarehouseQueryService` and the CLI
 * executors). The `Executor*` aliases are retained so existing importers keep
 * compiling; new code should prefer the canonical names.
 */
export type ExecutorQuerySettings = WarehouseQuerySettings
export type ExecutorQueryProfile = QueryProfileName
export type ExecutorQueryOptions = WarehouseQueryOptions

export interface WarehouseExecutorShape {
	/** The org ID for the current tenant — needed for raw SQL queries. */
	readonly orgId: string

	readonly query: <T = any>(
		pipe: WarehouseQueryName,
		params: Record<string, unknown>,
		options?: ExecutorQueryOptions,
	) => Effect.Effect<{ data: ReadonlyArray<T> }, ObservabilityError>

	/** Execute raw ClickHouse SQL. The SQL MUST include an OrgId filter. */
	readonly sqlQuery: <T = Record<string, unknown>>(
		sql: string,
		options?: ExecutorQueryOptions,
	) => Effect.Effect<ReadonlyArray<T>, ObservabilityError>
}

export class WarehouseExecutor extends Context.Service<WarehouseExecutor, WarehouseExecutorShape>()(
	"@maple/query-engine/observability/WarehouseExecutor",
) {}
