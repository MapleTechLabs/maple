import { Clock, Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { OrgId, UserId } from "@maple/domain/http"
import {
	makeWarehouseExecutor,
	WarehouseDriverError,
	type WarehouseSqlClient,
} from "@maple/query-engine/execution"
import type { WarehouseExecutorApi } from "@maple/query-engine/observability"
import { executeLocalQuery, type LocalQueryError } from "@maple/query-engine/local"
import { debugLog } from "../lib/debug"

const LOCAL_ORG_ID = Schema.decodeUnknownSync(OrgId)("local")
const LOCAL_USER_ID = Schema.decodeUnknownSync(UserId)("local")
const LOCAL_TENANT = { orgId: LOCAL_ORG_ID, userId: LOCAL_USER_ID, authMode: "local" as const }

/**
 * The local server's failures as the executor's driver error, so the same
 * classifier that reads the cloud drivers reads chDB: a refused query keeps its
 * status and ClickHouse identity, an unreachable binary is a transport failure.
 */
export const localDriverError = (error: LocalQueryError): WarehouseDriverError => {
	switch (error._tag) {
		case "@maple/query-engine/LocalQueryFailed":
			return new WarehouseDriverError({
				reason: "server",
				status: error.status,
				message: error.message,
				...(error.code === undefined ? undefined : { code: error.code }),
				...(error.type === undefined ? undefined : { type: error.type }),
				cause: error,
			})
		case "@maple/query-engine/LocalQueryMalformedResponse":
			return new WarehouseDriverError({ reason: "protocol", message: error.message, cause: error })
		case "@maple/query-engine/LocalQueryUnreachable":
			return new WarehouseDriverError({ reason: "transport", message: error.message, cause: error })
	}
}

// Lazy and interruptible: the request is bound to the query's scope. With
// `--debug`, the SQL and wall time are logged to stderr on success and failure
// alike, so a failing query still shows its SQL.
const localChdbClient = (baseUrl: string, http: HttpClient.HttpClient): WarehouseSqlClient => ({
	sql: (statement) =>
		Effect.gen(function* () {
			const startedAtMs = yield* Clock.currentTimeMillis
			return yield* executeLocalQuery(statement.text, baseUrl).pipe(
				Effect.map((data) => ({ data })),
				Effect.mapError(localDriverError),
				Effect.ensuring(
					Clock.currentTimeMillis.pipe(
						Effect.map((nowMs) => debugLog(`local query · ${nowMs - startedAtMs}ms`, statement.text)),
					),
				),
			)
		}).pipe(Effect.provideService(HttpClient.HttpClient, http)),
	insert: () =>
		// Local mode ingests via OTLP into the embedded chDB, never through the
		// warehouse `ingest` path.
		Effect.fail(
			new WarehouseDriverError({
				reason: "config",
				message: "local mode is read-only through the warehouse executor — ingest via OTLP",
			}),
		),
})

/**
 * A `WarehouseExecutor` backed by the local Maple binary's `/local/query`
 * endpoint — the REAL `makeWarehouseExecutor` from `@maple/query-engine`
 * (spans, error classification, OrgId scoping) with a chDB client and a
 * constant single-tenant route injected. The `chdb` backend dialect strips the
 * trailing `FORMAT` (the local server owns the output format) and skips
 * Tinybird's restricted-settings policy.
 *
 * This makes every `@maple/query-engine/observability` function — which only
 * depends on a `WarehouseExecutor` — work unchanged against local mode, with
 * the same `warehouse.backend="chdb"` span contract as the cloud.
 *
 * Captures the ambient `HttpClient` once; the executor's own client cache then
 * reuses the driver across queries.
 */
export const makeLocalWarehouseExecutorApi = (
	baseUrl: string,
): Effect.Effect<WarehouseExecutorApi, never, HttpClient.HttpClient> =>
	Effect.map(HttpClient.HttpClient, (http) =>
		makeWarehouseExecutor({
			createClient: () => Effect.succeed(localChdbClient(baseUrl, http)),
			resolveRoute: () =>
				Effect.succeed({
					source: "managed" as const,
					config: {
						kind: "chdb" as const,
						url: baseUrl,
						username: "",
						password: "",
						database: "default",
					},
					clientCacheKey: "local",
				}),
		}).asExecutor(LOCAL_TENANT),
	)
