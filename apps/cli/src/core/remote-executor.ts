import { Effect } from "effect"
import {
	type WarehouseExecutorShape,
	ObservabilityError,
	type ExecutorQueryOptions,
} from "@maple/query-engine/observability"

const RAW_SQL_REMOTE_MESSAGE =
	"Raw SQL (`maple query`) is only available in local mode. In remote mode, use the typed commands (services, traces, errors, logs, timeseries, …)."

/**
 * A `WarehouseExecutor` shape backed by the remote Maple API's generic
 * `POST /api/tinybird/query` endpoint — the cloud counterpart to the local
 * binary's `/local/query`.
 *
 *   - `query(pipe, params)` POSTs `{ pipe, params }` with a bearer token. The
 *     server compiles the pipe with the authenticated tenant's org id (the
 *     client never sends `org_id`, so it can't scope to another org) and
 *     returns `{ data }`.
 *   - `sqlQuery` is unsupported: a generic raw-SQL passthrough against the
 *     multi-tenant warehouse would let a client read other orgs' data, so it
 *     fails with a clear message. (Every CLI command except `maple query`
 *     routes through `query`, so this only affects raw SQL.)
 */
export const makeRemoteWarehouseExecutorShape = (
	apiUrl: string,
	token: string,
	orgId: string,
): WarehouseExecutorShape => {
	const endpoint = `${apiUrl.replace(/\/$/, "")}/api/tinybird/query`
	return {
		orgId,
		query: <T>(pipe: string, params: Record<string, unknown>, _options?: ExecutorQueryOptions) =>
			Effect.tryPromise({
				try: async (): Promise<{ data: ReadonlyArray<T> }> => {
					const res = await fetch(endpoint, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({ pipe, params }),
					})
					if (!res.ok) {
						const text = await res.text().catch(() => "")
						throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`)
					}
					const json = (await res.json()) as { data?: ReadonlyArray<T> }
					return { data: json.data ?? [] }
				},
				catch: (error) =>
					new ObservabilityError({
						message: error instanceof Error ? error.message : String(error),
						pipe,
					}),
			}),
		sqlQuery: <T = Record<string, unknown>>(_sql: string, _options?: ExecutorQueryOptions) =>
			Effect.fail(
				new ObservabilityError({ message: RAW_SQL_REMOTE_MESSAGE, category: "client" }),
			) as Effect.Effect<ReadonlyArray<T>, ObservabilityError>,
	}
}
