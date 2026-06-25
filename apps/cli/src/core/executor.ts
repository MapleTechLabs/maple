import { Effect, Schema } from "effect"
import { compilePipeQuery } from "@maple/query-engine/ch"
import { type WarehouseExecutorShape, type ExecutorQueryOptions } from "@maple/query-engine/observability"
import { OrgId } from "@maple/domain/http"
import {
	WarehouseQueryError,
	WarehouseSchemaDriftError,
	WarehouseValidationError,
} from "@maple/domain/http/warehouse-errors"
import { executeLocalQuery } from "@maple/query-engine/local"
import { debugLog } from "../lib/debug"

// Local mode is single-tenant: the Rust binary writes every row under this
// OrgId, and every compiled query filters on it. `OrgId` is a non-empty trimmed
// branded string, so "local" decodes cleanly (no cast needed).
const LOCAL_ORG_ID = Schema.decodeUnknownSync(OrgId)("local")

const toWarehouseError = (pipe: string) => (error: unknown) =>
	new WarehouseQueryError({
		message: error instanceof Error ? error.message : String(error),
		pipeName: pipe,
	})

// Cap `db.query.text` at 16 KB to match apps/api's WarehouseQueryService span.
const MAX_DB_QUERY_TEXT = 16 * 1024
const truncateSql = (sql: string) => (sql.length > MAX_DB_QUERY_TEXT ? sql.slice(0, MAX_DB_QUERY_TEXT) : sql)

/**
 * A `WarehouseExecutor` shape backed by the local Maple binary's `/local/query`
 * endpoint. Both executor methods reduce to raw SQL against the embedded chDB:
 *
 *   - `sqlQuery` posts the SQL directly.
 *   - `query(pipe, params)` compiles the pipe name to SQL via the shared
 *     `compilePipeQuery` dispatcher (the same one the cloud uses), then posts it.
 *
 * This makes every `@maple/query-engine/observability` function — which only
 * depend on a `WarehouseExecutor` — work unchanged against local mode.
 */
export const makeLocalWarehouseExecutorShape = (baseUrl: string): WarehouseExecutorShape => {
	// Run SQL against the local server, timing the round-trip and (under --debug)
	// printing the SQL + elapsed ms to stderr. The `finally` logs even on failure
	// so a failing query still shows its SQL.
	const exec = async <T>(sql: string, label: string): Promise<ReadonlyArray<T>> => {
		const started = performance.now()
		try {
			return await executeLocalQuery<T>(sql, baseUrl)
		} finally {
			debugLog(`${label} · ${Math.round(performance.now() - started)}ms`, sql)
		}
	}
	return {
		orgId: LOCAL_ORG_ID,
		sqlQuery: <T = Record<string, unknown>>(sql: string, options?: ExecutorQueryOptions) =>
			Effect.gen(function* () {
				const started = performance.now()
				const rows = yield* Effect.tryPromise({
					try: () => exec<T>(sql, "sqlQuery"),
					catch: toWarehouseError("sqlQuery"),
				})
				yield* Effect.annotateCurrentSpan({
					"db.duration_ms": Math.round(performance.now() - started),
					"result.rowCount": rows.length,
				})
				return rows
			}).pipe(
				Effect.withSpan("warehouse.sqlQuery", {
					kind: "client",
					attributes: {
						"db.system.name": "clickhouse",
						"peer.service": "chdb",
						"db.query.text": truncateSql(sql),
						"db.query.length": sql.length,
						"query.context": "sqlQuery",
						...(options?.profile ? { "query.profile": options.profile } : {}),
					},
				}),
			),
		compiledQuery: (compiled, options?: ExecutorQueryOptions) =>
			Effect.gen(function* () {
				const started = performance.now()
				const rows = yield* Effect.tryPromise({
					try: () => exec<Record<string, unknown>>(compiled.sql, "compiledQuery"),
					catch: toWarehouseError("compiledQuery"),
				})
				yield* Effect.annotateCurrentSpan({
					"db.duration_ms": Math.round(performance.now() - started),
					"result.rowCount": rows.length,
				})
				return yield* compiled.decodeRows(rows).pipe(
					Effect.mapError(
						(error) =>
							new WarehouseSchemaDriftError({
								message: error.message,
								pipeName: "compiledQuery",
								cause: error,
							}),
					),
				)
			}).pipe(
				Effect.withSpan("warehouse.compiledQuery", {
					kind: "client",
					attributes: {
						"db.system.name": "clickhouse",
						"peer.service": "chdb",
						"db.query.text": truncateSql(compiled.sql),
						"db.query.length": compiled.sql.length,
						"query.context": "compiledQuery",
						...(options?.profile ? { "query.profile": options.profile } : {}),
					},
				}),
			),
		compiledQueryFirst: (compiled, options?: ExecutorQueryOptions) =>
			Effect.gen(function* () {
				const started = performance.now()
				const rows = yield* Effect.tryPromise({
					try: () => exec<Record<string, unknown>>(compiled.sql, "compiledQueryFirst"),
					catch: toWarehouseError("compiledQueryFirst"),
				})
				yield* Effect.annotateCurrentSpan({
					"db.duration_ms": Math.round(performance.now() - started),
					"result.rowCount": rows.length,
				})
				return yield* compiled.decodeFirstRow(rows).pipe(
					Effect.mapError(
						(error) =>
							new WarehouseSchemaDriftError({
								message: error.message,
								pipeName: "compiledQueryFirst",
								cause: error,
							}),
					),
				)
			}).pipe(
				Effect.withSpan("warehouse.compiledQueryFirst", {
					kind: "client",
					attributes: {
						"db.system.name": "clickhouse",
						"peer.service": "chdb",
						"db.query.text": truncateSql(compiled.sql),
						"db.query.length": compiled.sql.length,
						"query.context": "compiledQueryFirst",
						...(options?.profile ? { "query.profile": options.profile } : {}),
					},
				}),
			),
		query: <T>(pipe: string, params: Record<string, unknown>, _options?: ExecutorQueryOptions) =>
			Effect.gen(function* () {
				const compiled = compilePipeQuery(pipe, { ...params, org_id: LOCAL_ORG_ID })
				if (!compiled) {
					return yield* new WarehouseValidationError({
						message: `Unsupported pipe in local mode: ${pipe}`,
						pipeName: pipe,
					})
				}
				yield* Effect.annotateCurrentSpan({
					"db.query.text": truncateSql(compiled.sql),
					"db.query.length": compiled.sql.length,
				})
				const started = performance.now()
				const rows = yield* Effect.tryPromise({
					try: () => exec<Record<string, unknown>>(compiled.sql, pipe),
					catch: toWarehouseError(pipe),
				})
				yield* Effect.annotateCurrentSpan({
					"db.duration_ms": Math.round(performance.now() - started),
					"result.rowCount": rows.length,
				})
				const decodedRows = yield* compiled.decodeRows(rows).pipe(
					Effect.mapError(
						(error) =>
							new WarehouseSchemaDriftError({
								message: error.message,
								pipeName: pipe,
								cause: error,
							}),
					),
				)
				// Type-erased executor boundary — mirrors WarehouseQueryService.asExecutor in apps/api.
				return { data: decodedRows as ReadonlyArray<T> }
			}).pipe(
				Effect.withSpan("warehouse.query", {
					kind: "client",
					attributes: {
						"db.system.name": "clickhouse",
						"peer.service": "chdb",
						"query.context": pipe,
					},
				}),
			),
	}
}
