import { Clock, Effect, Ref, Schedule } from "effect"
import {
	type WarehouseQueryRequest,
	WarehouseQueryResponse,
	WarehouseSchemaDriftError,
	WarehouseUpstreamError,
	WarehouseValidationError,
} from "@maple/domain/http"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import { compilePipeQuery, type CompiledQuery } from "../ch"
import type { ExecutorQueryOptions, WarehouseExecutorShape } from "../observability"
import { appendSettings, resolveSettings } from "../profiles"
import { mapWarehouseError, toWarehouseQueryError, type WarehouseSqlError } from "./errors"
import {
	SQL_LOG_MAX,
	SQL_TRACE_MAX,
	fingerprintSql,
	normalizeSqlForClickHouseClient,
	truncateSql,
} from "./fingerprint"
import type {
	ExecutionTenant,
	ResolvedWarehouseConfig,
	SqlQueryOptions,
	WarehouseExecutorDeps,
	WarehouseQueryServiceShape,
	WarehouseSqlClient,
} from "./ports"

const CLIENT_CACHE_TTL_MS = 30_000

interface CachedClient {
	client: WarehouseSqlClient
	cacheKey: string
	expiresAt: number
}

const sqlClientCacheKey = (config: ResolvedWarehouseConfig): string =>
	config._tag === "clickhouse"
		? `clickhouse:${config.url}:${config.username}:${config.password}:${config.database}`
		: `tinybird:${config.host}:${config.token}`

// Only retry transient upstream failures (5xx, 408, 429, network blips). Non-transient
// errors (auth, config, schema_drift, query) re-fail immediately — there's nothing to
// recover from by trying again. Caps at 2 retries (3 attempts total) to bound worst-case
// tail latency: at concurrency=4 in the alerting tick, a fully-degraded warehouse can
// still let the tick finish within its 60s window.
const TRANSIENT_RETRY_SCHEDULE = Schedule.exponential("100 millis", 2.0).pipe(
	Schedule.both(Schedule.recurs(2)),
)

const isTransientUpstreamError = (error: WarehouseSqlError): boolean =>
	error instanceof WarehouseUpstreamError

/**
 * Build the managed-warehouse executor. Owns SQL execution, retry, error
 * mapping, the per-instance client cache, OrgId scoping enforcement, and span
 * instrumentation. The host app injects driver construction (`createClient`)
 * and per-org config resolution (`resolveConfig`) via `deps`.
 *
 * The client cache is per-instance (one per layer build): a single instance in
 * production (the layer is built once) and a fresh one per test build, so tests
 * never see a stale client from a prior fake factory.
 */
export const makeWarehouseExecutor = (deps: WarehouseExecutorDeps): WarehouseQueryServiceShape => {
	const clientCache = new Map<string, CachedClient>()

	const getCachedOrCreateClient = (
		cacheKey: string,
		config: ResolvedWarehouseConfig,
		nowMs: number,
	): WarehouseSqlClient => {
		const configKey = sqlClientCacheKey(config)
		const cached = clientCache.get(cacheKey)
		if (cached && cached.cacheKey === configKey && cached.expiresAt > nowMs) {
			return cached.client
		}
		const client = deps.createClient(config)
		clientCache.set(cacheKey, { client, cacheKey: configKey, expiresAt: nowMs + CLIENT_CACHE_TTL_MS })
		return client
	}

	const executeSql = Effect.fn("WarehouseQueryService.executeSql")(function* (
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options?: SqlQueryOptions,
	) {
		const startedAtMs = yield* Clock.currentTimeMillis
		yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
		yield* Effect.annotateCurrentSpan("tenant.userId", tenant.userId)
		yield* Effect.annotateCurrentSpan("tenant.authMode", tenant.authMode)

		const leftoverParam = sql.match(/__PARAM_(\w+)__/)
		if (leftoverParam) {
			// An unresolved param is a compile-time bug in Maple's query construction,
			// not a recoverable runtime failure — surface it as a defect.
			return yield* Effect.die(
				new Error(
					`Compiled SQL contains unresolved param '${leftoverParam[1]}' — query was built with param.${leftoverParam[1]}() but '${leftoverParam[1]}' was not provided in the runtime params object`,
				),
			)
		}

		const resolved = yield* deps.resolveConfig(tenant, pipe)
		const peerService = resolved.config._tag === "clickhouse" ? "clickhouse" : "tinybird"
		yield* Effect.annotateCurrentSpan("db.system", peerService)
		yield* Effect.annotateCurrentSpan("peer.service", peerService)
		const settings = resolveSettings(options)
		const sqlForClient =
			resolved.config._tag === "clickhouse" ? normalizeSqlForClickHouseClient(sql) : sql
		const finalSql = appendSettings(sqlForClient, settings)
		const sqlLength = finalSql.length
		const sqlTruncated = sqlLength > SQL_TRACE_MAX
		yield* Effect.annotateCurrentSpan("db.statement", truncateSql(finalSql, SQL_TRACE_MAX))
		yield* Effect.annotateCurrentSpan("db.statement.length", sqlLength)
		yield* Effect.annotateCurrentSpan("db.statement.truncated", sqlTruncated)
		yield* Effect.annotateCurrentSpan("db.statement.fingerprint", fingerprintSql(finalSql))
		yield* Effect.annotateCurrentSpan("query.pipe", pipe)
		if (options?.context) yield* Effect.annotateCurrentSpan("query.context", options.context)
		if (options?.profile) yield* Effect.annotateCurrentSpan("query.profile", options.profile)
		if (settings) yield* Effect.annotateCurrentSpan("ch.settings", JSON.stringify(settings))

		const cacheKey = resolved.source === "managed" ? "__managed__" : tenant.orgId
		const client = getCachedOrCreateClient(cacheKey, resolved.config, yield* Clock.currentTimeMillis)
		const retryAttempts = yield* Ref.make(0)
		const result = yield* Effect.tryPromise({
			try: () => client.sql(finalSql),
			catch: (error) => mapWarehouseError(pipe, error),
		}).pipe(
			Effect.tapError((error) =>
				isTransientUpstreamError(error) ? Ref.update(retryAttempts, (n) => n + 1) : Effect.void,
			),
			Effect.retry({
				schedule: TRANSIENT_RETRY_SCHEDULE,
				while: isTransientUpstreamError,
			}),
			Effect.tapError((error) =>
				Effect.gen(function* () {
					const elapsedMs = (yield* Clock.currentTimeMillis) - startedAtMs
					const attempts = yield* Ref.get(retryAttempts)
					yield* Effect.annotateCurrentSpan("db.duration_ms", elapsedMs)
					yield* Effect.annotateCurrentSpan("db.retry.attempts", attempts)
					yield* Effect.logError("WarehouseQueryService.executeSql failed", {
						pipe,
						context: options?.context,
						orgId: tenant.orgId,
						backend: resolved.config._tag,
						durationMs: elapsedMs,
						retryAttempts: attempts,
						error: String(error),
						message: error.message,
						sql: truncateSql(finalSql, SQL_LOG_MAX),
						sqlLength,
						sqlFingerprint: fingerprintSql(finalSql),
						profile: options?.profile,
					})
				}),
			),
		)

		yield* Effect.annotateCurrentSpan("result.rowCount", result.data.length)
		yield* Effect.annotateCurrentSpan("db.duration_ms", (yield* Clock.currentTimeMillis) - startedAtMs)
		yield* Effect.annotateCurrentSpan("db.retry.attempts", yield* Ref.get(retryAttempts))
		return result.data
	})

	const query = Effect.fn("WarehouseQueryService.query")(function* (
		tenant: ExecutionTenant,
		payload: WarehouseQueryRequest,
		options?: SqlQueryOptions,
	) {
		yield* Effect.annotateCurrentSpan("pipe", payload.pipe)
		yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)

		if (!tenant.orgId || tenant.orgId.trim() === "") {
			return yield* new WarehouseValidationError({
				pipe: payload.pipe,
				message: "org_id must not be empty",
			})
		}

		const compiled = compilePipeQuery(payload.pipe, {
			...payload.params,
			org_id: tenant.orgId,
		})

		if (!compiled) {
			return yield* new WarehouseValidationError({
				message: `Unsupported pipe: ${payload.pipe}`,
				pipe: payload.pipe,
			})
		}

		const rows = yield* executeSql(tenant, compiled.sql, payload.pipe, options)
		const decodedRows = yield* compiled.decodeRows(rows).pipe(
			Effect.mapError(
				(error) =>
					new WarehouseSchemaDriftError({
						pipe: payload.pipe,
						message: error.message,
						cause: error,
					}),
			),
		)

		return new WarehouseQueryResponse({
			data: Array.from(decodedRows),
		})
	})

	const sqlQuery = Effect.fn("WarehouseQueryService.sqlQuery")(function* (
		tenant: ExecutionTenant,
		sql: string,
		options?: SqlQueryOptions,
	) {
		if (!tenant.orgId || tenant.orgId.trim() === "") {
			return yield* new WarehouseValidationError({
				pipe: "sqlQuery",
				message: "org_id must not be empty (sqlQuery)",
			})
		}
		if (!sql.includes("OrgId")) {
			return yield* new WarehouseValidationError({
				pipe: "sqlQuery",
				message: "SQL query must contain OrgId filter (sqlQuery)",
			})
		}
		return yield* executeSql(tenant, sql, "sqlQuery", options)
	})

	const compiledQuery = Effect.fn("WarehouseQueryService.compiledQuery")(function* <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQuery<T>,
		options?: SqlQueryOptions,
	) {
		const rows = yield* sqlQuery(tenant, compiled.sql, options)
		return yield* compiled.decodeRows(rows).pipe(
			Effect.mapError(
				(error) =>
					new WarehouseSchemaDriftError({
						pipe: "compiledQuery",
						message: error.message,
						cause: error,
					}),
			),
		)
	})

	const compiledQueryFirst = Effect.fn("WarehouseQueryService.compiledQueryFirst")(function* <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQuery<T>,
		options?: SqlQueryOptions,
	) {
		const rows = yield* sqlQuery(tenant, compiled.sql, options)
		return yield* compiled.decodeFirstRow(rows).pipe(
			Effect.mapError(
				(error) =>
					new WarehouseSchemaDriftError({
						pipe: "compiledQueryFirst",
						message: error.message,
						cause: error,
					}),
			),
		)
	})

	const ingest = Effect.fn("WarehouseQueryService.ingest")(function* <T>(
		tenant: ExecutionTenant,
		datasource: string,
		rows: ReadonlyArray<T>,
	) {
		yield* Effect.annotateCurrentSpan("datasource", datasource)
		yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
		yield* Effect.annotateCurrentSpan("rowCount", rows.length)

		if (rows.length === 0) return

		const label = `ingest:${datasource}`
		const resolved = yield* deps.resolveConfig(tenant, label)

		// Insert through the same client the read path uses (official
		// @clickhouse/client-web for ClickHouse, Tinybird Events API for
		// Tinybird) so the wire protocol is handled correctly — a hand-rolled
		// `?query=INSERT … FORMAT JSONEachRow` POST had its query param dropped
		// by managed ClickHouse, which then parsed the NDJSON body as SQL.
		const cacheKey = resolved.source === "managed" ? "__managed__" : tenant.orgId
		const client = getCachedOrCreateClient(cacheKey, resolved.config, yield* Clock.currentTimeMillis)

		yield* Effect.tryPromise({
			try: () => client.insert(datasource, rows),
			catch: (error) => toWarehouseQueryError(label, error),
		}).pipe(
			Effect.tapError((error) =>
				Effect.logError("WarehouseQueryService.ingest failed", {
					datasource,
					rowCount: rows.length,
					backend: resolved.config._tag,
					error: String(error),
					message: error.message,
				}),
			),
		)
	})

	const asExecutor = (tenant: ExecutionTenant): WarehouseExecutorShape => ({
		orgId: tenant.orgId,
		query: <T>(
			pipe: WarehouseQueryName,
			params: Record<string, unknown>,
			options?: ExecutorQueryOptions,
		) =>
			query(tenant, { pipe, params }, options).pipe(
				Effect.map((response) => ({ data: response.data as unknown as ReadonlyArray<T> })),
				Effect.withSpan("WarehouseExecutor.query", {
					attributes: { pipe, orgId: tenant.orgId, "query.profile": options?.profile },
				}),
			),
		sqlQuery: <T>(sql: string, options?: ExecutorQueryOptions) =>
			sqlQuery(tenant, sql, { ...options, context: "warehouseExecutor.sqlQuery" }).pipe(
				Effect.map((rows) => rows as unknown as ReadonlyArray<T>),
				Effect.withSpan("WarehouseExecutor.sqlQuery", {
					attributes: { orgId: tenant.orgId, "query.profile": options?.profile },
				}),
			),
		compiledQuery: <T>(compiled: CompiledQuery<T>, options?: ExecutorQueryOptions) =>
			compiledQuery(tenant, compiled, { ...options, context: "warehouseExecutor.compiledQuery" }).pipe(
				Effect.withSpan("WarehouseExecutor.compiledQuery", {
					attributes: { orgId: tenant.orgId, "query.profile": options?.profile },
				}),
			),
		compiledQueryFirst: <T>(compiled: CompiledQuery<T>, options?: ExecutorQueryOptions) =>
			compiledQueryFirst(tenant, compiled, {
				...options,
				context: "warehouseExecutor.compiledQueryFirst",
			}).pipe(
				Effect.withSpan("WarehouseExecutor.compiledQueryFirst", {
					attributes: { orgId: tenant.orgId, "query.profile": options?.profile },
				}),
			),
	})

	return { query, sqlQuery, compiledQuery, compiledQueryFirst, ingest, asExecutor } satisfies WarehouseQueryServiceShape
}
