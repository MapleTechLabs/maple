import { Effect, Layer, Schema } from "effect"
import { compilePipeQuery } from "@maple/query-engine/ch"
import {
	WarehouseExecutor,
	ObservabilityError,
	type ExecutorQueryOptions,
} from "@maple/query-engine/observability"
import { OrgId } from "@maple/domain/http"
import { executeLocalQuery } from "./local-query"

// Local mode is single-tenant: the Rust binary writes every row under this
// OrgId, and every compiled query filters on it. `OrgId` is a non-empty trimmed
// branded string, so "local" decodes cleanly (no cast needed).
const LOCAL_ORG_ID = Schema.decodeUnknownSync(OrgId)("local")

const DEFAULT_BASE_URL = "http://127.0.0.1:4318"

const toObservabilityError = (pipe: string | undefined) => (error: unknown) =>
	new ObservabilityError({
		message: error instanceof Error ? error.message : String(error),
		...(pipe ? { pipe } : {}),
	})

/**
 * A `WarehouseExecutor` backed by the local Maple binary's `/local/query`
 * endpoint. Both executor methods reduce to raw SQL against the embedded chDB:
 *
 *   - `sqlQuery` posts the SQL directly.
 *   - `query(pipe, params)` compiles the pipe name to SQL via the shared
 *     `compilePipeQuery` dispatcher (the same one the cloud uses), then posts it.
 *
 * This makes every `@maple/query-engine/observability` function — which only
 * depend on a `WarehouseExecutor` — work unchanged against local mode.
 */
export const makeLocalWarehouseExecutor = (baseUrl: string) =>
	Layer.succeed(
		WarehouseExecutor,
		WarehouseExecutor.of({
			orgId: LOCAL_ORG_ID,
			sqlQuery: <T = Record<string, unknown>>(sql: string, _options?: ExecutorQueryOptions) =>
				Effect.tryPromise({
					try: () => executeLocalQuery<T>(baseUrl, sql),
					catch: toObservabilityError(undefined),
				}),
			query: <T>(pipe: string, params: Record<string, unknown>, _options?: ExecutorQueryOptions) =>
				Effect.gen(function* () {
					const compiled = compilePipeQuery(pipe, { ...params, org_id: LOCAL_ORG_ID })
					if (!compiled) {
						return yield* new ObservabilityError({
							message: `Unsupported pipe in local mode: ${pipe}`,
							pipe,
						})
					}
					const rows = yield* Effect.tryPromise({
						try: () => executeLocalQuery<Record<string, unknown>>(baseUrl, compiled.sql),
						catch: toObservabilityError(pipe),
					})
					// Type-erased executor boundary — mirrors WarehouseExecutorLive in apps/api.
					return { data: compiled.castRows(rows) as unknown as ReadonlyArray<T> }
				}),
		}),
	)

/** Base URL of the local Maple binary, overridable via `MAPLE_LOCAL_URL`. */
export const resolveBaseUrl = (): string => process.env.MAPLE_LOCAL_URL ?? DEFAULT_BASE_URL

/** Env-resolved executor layer shared by the CLI and the HTTP server. */
export const LocalWarehouseExecutorLive = makeLocalWarehouseExecutor(resolveBaseUrl())
