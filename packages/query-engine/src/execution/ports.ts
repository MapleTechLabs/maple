import type { Effect } from "effect"
import type { OrgId } from "@maple/domain"
import type { WarehouseQueryRequest, WarehouseQueryResponse, WarehouseQueryError } from "@maple/domain/http"
import type { WarehouseExecutorShape } from "../observability"
import type { QueryProfileName, WarehouseQuerySettings } from "../profiles"
import type { WarehouseSqlError } from "./errors"

/** The minimal tenant surface the executor reads (org scope + identity for spans). */
export interface ExecutionTenant {
	readonly orgId: OrgId
	readonly userId: string
	readonly authMode: string
}

export type SqlQueryOptions = {
	profile?: QueryProfileName
	settings?: WarehouseQuerySettings
	/**
	 * Semantic name for the query (e.g. "errorsByType", "spanHierarchy").
	 * Annotated on the executeSql span as `query.context` so traces can be
	 * filtered and grouped by call site without re-running the SQL.
	 */
	context?: string
}

/** Resolved upstream connection config for a tenant's queries. */
export type ResolvedWarehouseConfig =
	| {
			readonly _tag: "clickhouse"
			readonly url: string
			readonly username: string
			readonly password: string
			readonly database: string
	  }
	| {
			readonly _tag: "tinybird"
			readonly host: string
			readonly token: string
	  }

/** Minimal client interface — raw SQL execution plus row inserts. */
export interface WarehouseSqlClient {
	readonly sql: (sql: string) => Promise<{ data: ReadonlyArray<Record<string, unknown>> }>
	readonly insert: (datasource: string, rows: ReadonlyArray<unknown>) => Promise<void>
}

/**
 * The injected dependencies of the warehouse executor. The host app provides
 * the driver construction (`createClient`) and the per-org config resolution
 * (`resolveConfig`, which reads the org-override DB row / env and emits the
 * `clientSource` / `db.client` span annotations); the executor itself — error
 * mapping, retry, client cache, OrgId scoping, span instrumentation — lives in
 * this package.
 */
export interface WarehouseExecutorDeps {
	readonly createClient: (config: ResolvedWarehouseConfig) => WarehouseSqlClient
	readonly resolveConfig: (
		tenant: ExecutionTenant,
		label: string,
	) => Effect.Effect<
		{ readonly config: ResolvedWarehouseConfig; readonly source: "managed" | "org_override" },
		WarehouseQueryError
	>
}

export interface WarehouseQueryServiceShape {
	readonly query: (
		tenant: ExecutionTenant,
		payload: WarehouseQueryRequest,
		options?: SqlQueryOptions,
	) => Effect.Effect<WarehouseQueryResponse, WarehouseSqlError>
	readonly sqlQuery: (
		tenant: ExecutionTenant,
		sql: string,
		options?: SqlQueryOptions,
	) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, WarehouseSqlError>
	readonly ingest: <T>(
		tenant: ExecutionTenant,
		datasource: string,
		rows: ReadonlyArray<T>,
	) => Effect.Effect<void, WarehouseQueryError>
	/**
	 * Present this service as the package-level `WarehouseExecutor` for a given
	 * tenant — the single managed-warehouse implementation of that interface.
	 */
	readonly asExecutor: (tenant: ExecutionTenant) => WarehouseExecutorShape
}
